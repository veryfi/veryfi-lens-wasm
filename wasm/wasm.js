const processMethods = {
  Document: "findDocument",
  Stitcher: "stitchImage",
  StitcherProcess: "stitchProcessFrame",
};

export class WasmWrapper {
  constructor() {
    this.loaded = false;
    this.documentDetectorLoaded = false;
    this.stitcherLoaded = false;
    this.cardDetectorLoaded = false;
    this.firstRun = true;
    this.client_id = "";
  }

  async simd() {
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
        1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
      ])
    );
  }

  async threads() {
    try {
      const testBuffer = new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3,
        1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11,
      ]);
      if (typeof MessageChannel !== "undefined") {
        new MessageChannel().port1.postMessage(new SharedArrayBuffer(1));
      }
      return WebAssembly.validate(testBuffer);
    } catch (e) {
      return false;
    }
  }

  /** @private */
  selectDir(useSimd) {
    const userAgent = navigator.userAgent;
    if (!useSimd) return "nonsimd";
    if (userAgent.indexOf("AppleWebKit") > -1) return "tfsimd";
    return "simd";
  }

  async initialize(client_id) {
    this.client_id = client_id;
    const features = await this.checkFeatures_();
    const { useSimd, useThreads } = features;
    if (!useThreads) {
    console.warn(
    "Threads disabled, seems that the security requirements for SharedArrayBuffer are not met"
    );
    return;
    }
    const dir = this.selectDir(useSimd);
await this.loadModuleScript_("/wasm/" + dir + "/veryfi-wasm.js");
    this.wasmModule = await createModule();
    this.loaded = true;
  }

  // async initialize(client_id) {
  //   this.client_id = client_id
  //   const features = await this.checkFeatures_();
  //   const { useSimd, useThreads } = features;

  //   if (!useThreads) {
  //     console.warn("Threads disabled, seems that the security requirements for SharedArrayBuffer are not met");
  //     return;
  //   }

  //   // Select the appropriate directory based on features
  //   const dir = this.selectDir(useSimd);

  //   // Dynamically import the wasm module script
  //   await import(`./${dir}/veryfi-wasm.js`);

  //   // Create the Wasm module
  //   this.wasmModule = await createModule();
  //   this.loaded = true;
  // }

  setDocumentCallback(callback) {
    if (!this.loaded || this.documentDetectorLoaded) return;
    this.wasmModule.ccall(
      "initDocumentDetector",
      null,
      ["string"],
      [this.client_id]
    );
    let documentCallback = this.wasmModule.addFunction(callback, "viiiiiiiii");
    this.documentDetectorLoaded = this.wasmModule.ccall(
      "setDocumentDetectorCallback",
      "boolean",
      ["number"],
      [documentCallback]
    );
  }

  setCardCallback(callback) {
    if (!this.loaded || this.cardDetectorLoaded) return;
    this.wasmModule.ccall(
      "initCardDetector",
      null,
      ["string"],
      [this.client_id]
    );
    let cardDetectorCallback = this.wasmModule.addFunction(callback, "viiiii");
    this.cardDetectorLoaded = this.wasmModule.ccall(
      "setCardDetectorCallback",
      "boolean",
      ["number"],
      [cardDetectorCallback]
    );
  }

  setStitcherCallback(callback) {
    if (!this.loaded || this.stitcherLoaded) return;
    this.wasmModule.ccall("initStitcher", null, ["string"], [this.client_id]);
    let stitcherCallback = this.wasmModule.addFunction(callback, "viiiiiiiiii");
    // viiiiiiiii
    // i -> StitcherResult
    // i -> x1
    // i -> y1
    // i -> x2
    // i -> y2
    // i -> x3
    // i -> y3
    // i -> x4
    // i -> y4
    // i -> preview from MatResult Struct (use getResultFromBuffer)
    this.stitcherLoaded = this.wasmModule.ccall(
      "setStitcherCallback",
      "boolean",
      ["number"],
      [stitcherCallback]
    );
  }

  getCC(bitmap) {
    if (!this.cardDetectorLoaded) return;
    const buffer = this.setBitmapOnWASMMemory_(bitmap);
    let outputBuffer = this.wasmModule.ccall(
      "getCC",
      "number",
      ["number", "number", "number", "number", "number"],
      [buffer, bitmap.width, bitmap.height, true]
    );

    this.freeBuffer_(buffer);
    return this.getResultFromBuffer(outputBuffer);
  }

  cropDocument(bitmap) {
    if (!this.documentDetectorLoaded) return;
    const buffer = this.setBitmapOnWASMMemory_(bitmap);
    let outputBuffer = this.wasmModule.ccall(
      "cropImage",
      "number",
      ["number", "number", "number", "boolean"],
      [buffer, bitmap.width, bitmap.height, true]
    );

    this.freeBuffer_(buffer);
    return this.getResultFromBuffer(outputBuffer);
  }

  getStitchedImage() {
    if (!this.stitcherLoaded) return;
    let outputBuffer = this.wasmModule.ccall("getStitchedImage", "int");
    let { data, blurLevel, outputHeight, outputWidth } =
      this.getResultFromBuffer(outputBuffer);
    return { data, blurLevel, outputHeight, outputWidth };
  }

  processDocument(bitmap, mode = "Document") {
    if (!this.stitcherLoaded && !this.documentDetectorLoaded) return;
    const buffer = this.setBitmapOnWASMMemory_(bitmap);
    let time1 = Date.now();
    const func = processMethods[mode];
    this.wasmModule.ccall(
      func,
      null,
      ["number", "number", "number"],
      [buffer, bitmap.width, bitmap.height]
    );
    // console.log(`Time ${Date.now() - time1}`);
    this.freeBuffer_(buffer);
  }

  cropWasm(bitmap, corners) {
    if (!this.loaded) return;
    const buffer = this.setBitmapOnWASMMemory_(bitmap);
    let cornersPtr = this.wasmModule._malloc(4 * 2 * 4);
    let startIndex = cornersPtr / 4;
    this.wasmModule.HEAP32.set(corners, startIndex);
    let outputBuffer = this.wasmModule.ccall(
      "crop",
      "number",
      ["number", "number", "number", "number", "boolean"],
      [buffer, bitmap.width, bitmap.height, cornersPtr, true]
    );
    this.freeBuffer_(buffer);
    this.freeBuffer_(cornersPtr);
    return this.getResultFromBuffer(outputBuffer);
  }

  getResultFromBuffer(outputBuffer) {
    let struct = Array.from({ length: 3 }, (_, i) =>
      new DataView(
        new Uint8Array(
          this.wasmModule.HEAPU8.subarray(outputBuffer, outputBuffer + 12)
        ).buffer
      ).getInt32(i * 4, true)
    );
    let [matAddress, outputHeight, outputWidth] = struct;
    let blurLevel =
      this.wasmModule.HEAPF32[
        (outputBuffer + 12) / Float32Array.BYTES_PER_ELEMENT
      ];
    const bufferData = this.wasmModule.HEAPU8.subarray(
      matAddress,
      matAddress + outputHeight * outputWidth * 4
    );
    const data = Uint8ClampedArray.from(bufferData);
    return { data, blurLevel, outputHeight, outputWidth };
  }

  // /** @private */
  // async checkFeatures_() {
  //   let useSimd = await wasmFeatureDetect.simd();
  //   let useThreads = await wasmFeatureDetect.threads();
  //   console.log(`useSimd: ${useSimd}, useThreads: ${useThreads}`);
  //   return { useSimd, useThreads };
  // }

  /** @private */
  async checkFeatures_() {
    let useSimd = await this.simd();
    let useThreads = await this.threads();
    console.log(`SIMD available: ${useSimd}`);
    console.log(`Threads available: ${useThreads}`)
    !useThreads && console.log("Threads disabled, seems that the security requirements for SharedArrayBuffer are not met");
    return { useSimd, useThreads };
  }

/** @private */
  loadModuleScript_(jsUrl) {
    return new Promise((resolve, reject) => {
let script = document.createElement("script");
script.onload = () => {
resolve();
};
script.onerror = () => {
reject();
      };
      script.src = jsUrl;
      document.body.appendChild(script);
});
}

  /** @private */
  createBuffer_(bitmap) {
    return this.wasmModule._malloc(bitmap.width * bitmap.height * 4);
  }

  /** @private */
  freeBuffer_(buffer) {
    this.wasmModule._free(buffer);
  }

  /** @private */
  convertImageDataToBitmap_(imageData) {
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
    }

    this.canvas.width = imageData.width;
    this.canvas.height = imageData.height;

    const ctx = this.canvas.getContext("2d");
    ctx.putImageData(imageData, 0, 0);

    return createImageBitmap(this.canvas);
  }

  /** @private */
  convertBitmapToBlob_(bitmap) {
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
    }
    this.canvas.width = bitmap.width;
    this.canvas.height = bitmap.height;
    const contextOptions = { willReadFrequently: true };
    const ctx = this.canvas.getContext("2d", contextOptions);
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
  }

  /** @private */
  setBitmapOnWASMMemory_(bitmap) {
    const blob = this.convertBitmapToBlob_(bitmap);
    const buffer = this.createBuffer_(bitmap);
    this.wasmModule.HEAPU8.set(blob.data, buffer);
    return buffer;
  }

  destroy() {
    this.wasmModule.ccall("release");
  }
}
