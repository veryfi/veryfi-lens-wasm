const processMethods = {
  Document: "findDocument",
  Stitcher: "stitchImage",
  StitcherProcess: "stitchProcessFrame",
};

const creditCardStatuses = [
  "AutoCaptureResultWaiting",
  "AutoCaptureResultErrorDocumentNotDetected",
  "AutoCaptureResultDone",
  "AutoCaptureResultNoModelDetected",
];

export class WasmWrapper {
  constructor() {
    this.loaded = false;
    this.documentDetectorLoaded = false;
    this.stitcherLoaded = false;
    this.cardDetectorLoaded = false;
    this.lcdDetectorLoaded = false;
    this.firstRun = true;
    this.client_id = "";
    this.callback = null
    this.frameCount = 0;
    this.lcdDetectionInterval = 5;
    this.lcdResult = null;
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
    console.log('Module initialized')
  }

  setDocumentCallback(callback) {
    if (!this.loaded || this.documentDetectorLoaded) return;
    this.wasmModule.ccall(
      "initDocumentDetector",
      null,
      ["string"],
      [this.client_id]
    );
    let internalCallback = (detectorResult, pointer, nDocs) => {
      const corners = [];
      const baseIndex = pointer / 4;
      const numValues = 4 * 2 * nDocs;
      for (let i = 0; i < numValues; i += 2) {
        corners.push({
          x: this.wasmModule.HEAP32[baseIndex + i],
          y: this.wasmModule.HEAP32[baseIndex + i + 1],
        });
      }
      callback(detectorResult, corners, nDocs);
    };

    this.callback = this.wasmModule.addFunction(
      internalCallback,
      "viii"
    );
    this.documentDetectorLoaded = this.wasmModule.ccall(
      "setDocumentDetectorCallback",
      "boolean",
      ["number"],
      [this.callback]
    );
  }

  initCardDetector() {
    if (!this.loaded) return false;
    console.log('CC inited')
    const success = this.wasmModule.ccall("initCardDetector", "bool", [], []);
    return success;
  }

  setCardCallback(callback) {
    if (!this.loaded || this.cardDetectorLoaded) return;
    this.wasmModule.ccall("initCardDetector", "boolean");
    this.callback = this.wasmModule.addFunction(callback, "viiiii");
    this.cardDetectorLoaded = this.wasmModule.ccall(
      "setCardDetectorCallback",
      "boolean",
      ["number"],
      [this.callback]
    );
  }

  setCreditCardCallback(callback) {
    console.log('Detector')
    // if (!this.loaded) return false;
    this.callback = this.wasmModule.addFunction(
      (autoCaptureState, namePtr, numPtr, datePtr, cvvPtr) => {
        const name = this.wasmModule.UTF8ToString(namePtr);
        const num = this.wasmModule.UTF8ToString(numPtr);
        const date = this.wasmModule.UTF8ToString(datePtr);
        const cvv = this.wasmModule.UTF8ToString(cvvPtr);
        callback(autoCaptureState, name, num, date, cvv);
      },
      "viiiii"
    );
    // viiiii
    // v -> void (return type)
    // i -> autoCaptureState (int)
    // i -> name (pointer to char)
    // i -> num (pointer to char)
    // i -> date (pointer to char)
    // i -> cvv (pointer to char)

    const success = this.wasmModule.ccall(
      "setCreditCardCallback",
      "boolean",
      ["number"],
      [this.callback]
    );
    return success;
  }

  setStitcherCallback(callback) {
    if (!this.loaded || this.stitcherLoaded) return;

    this.wasmModule.ccall("initStitcher", null, ["string"], [this.client_id]);

    let internalStitcherCallback = (
      stitcherResult,
      cornerPointer,
      nDocs,
      previewPointer
    ) => {
      const corners = [];
      const baseIndex = cornerPointer / 4;
      const numValues = 4 * 2 * nDocs;

      for (let i = 0; i < numValues; i += 2) {
        corners.push({
          x: this.wasmModule.HEAP32[baseIndex + i],
          y: this.wasmModule.HEAP32[baseIndex + i + 1],
        });
      }

      const previewData = this.getResultFromBuffer(previewPointer);
      callback(stitcherResult, corners, nDocs, previewData);
    };

    this.callback = this.wasmModule.addFunction(
      internalStitcherCallback,
      "viiii"
    );
    this.stitcherLoaded = this.wasmModule.ccall(
      "setStitcherCallback",
      "boolean",
      ["number"],
      [this.callback]
    );
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

  /** @private */
  async checkFeatures_() {
    let useSimd = await this.simd();
    let useThreads = await this.threads();
    console.log(`SIMD available: ${useSimd}`);
    console.log(`Threads available: ${useThreads}`);
    !useThreads &&
      console.log(
        "Threads disabled, seems that the security requirements for SharedArrayBuffer are not met"
      );
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
    // console.log(bitmap)
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

  setCardDetectorCallback(
    callback,
    top = 30,
    bottom = 80,
    findNum = true,
    findName = true,
    findDate = true,
    findCvv = true,
    loadNumModel = true,
    loadNameModel = true,
    loadDateCvvModel = true,
    preFetchLCDModel = true
  ) {
    if (bottom - top != 50)
      throw new Error("botton - top should be equal to 50");
    if (this.callback) return;
    this.wasmModule.ccall(
      "initCardDetector",
      null,
      ["string", "number", "number", "number", "number", "number", "number", "number"],
      [
        this.client_id,
        top,
        bottom,
        findNum ? 1 : 0,
        findName ? 1 : 0,
        findDate ? 1 : 0,
        findCvv ? 1 : 0,
        loadNumModel ? 1 : 0,
        loadNameModel ? 1 : 0,
        loadDateCvvModel ? 1 : 0,
        preFetchLCDModel ? 1 : 0,
      ]
    );
    this.lcdDetectorLoaded = true;
    this.callback = this.wasmModule.addFunction(callback, "viiiii");
    this.wasmModule.ccall(
      "setCreditCardCallback",
      "boolean",
      ["number"],
      [this.callback]
    );
  }

  ptrToString(ptr) {
    const memory = this.wasmModule.HEAPU8;
    let end = ptr;
    while (memory[end] && end - ptr < 50) end++;
    const subarray = Uint8ClampedArray.from(memory.subarray(ptr, end));
    return new TextDecoder("utf-8").decode(subarray);
  }

  parseCreditCardCallback(status, namePtr, numPtr, datePtr, cvvPtr) {
    const creditCardStatus = creditCardStatuses[status];
    const name = this.ptrToString(namePtr);
    const number = this.ptrToString(numPtr);
    const date = this.ptrToString(datePtr);
    const cvv = this.ptrToString(cvvPtr);
    return {
      status: creditCardStatus,
      name: name,
      number: number,
      date: date,
      cvv: cvv,
    };
  }

  resetAutoCapture(
    findNum = true,
    findName = true,
    findDate = true,
    findCvv = true
  ) {
    this.wasmModule.ccall(
      "resetAutoCapture",
      null,
      ["number", "number", "number", "number"],
      [findNum ? 1 : 0, findName ? 1 : 0, findDate ? 1 : 0, findCvv ? 1 : 0]
    );
  }

   detectLCD(bitmap) {
    if (!this.loaded || !this.lcdDetectorLoaded) {
      console.warn("LCD detector not initialized");
      return null;
    }
    const buffer = this.setBitmapOnWASMMemory_(bitmap);
    let outputBuffer = this.wasmModule.ccall(
      "detectLCD",
      "number",
      ["number", "number", "number"],
      [buffer, bitmap.width, bitmap.height]
    );
    this.freeBuffer_(buffer);
    if (outputBuffer === 0) {
      console.warn("LCD detection failed or not ready");
      return null;
    }
    const result = new Float32Array(this.wasmModule.HEAPF32.buffer, outputBuffer, 2);
    return { lcdProb: result[0], objProb: result[1] };
  }

  forceAutoCapture(bitmap) {
    //stop sending frames
    const blob = this.convertBitmapToBlob_(bitmap);
    const buffer = this.createBuffer_(bitmap);
    this.wasmModule.HEAPU8.set(blob.data, buffer);
    const resultAddress = this.wasmModule.ccall(
      "creditCardForceResult",
      "number",
      ["number", "number", "number"],
      [buffer, bitmap.width, bitmap.height]
    );
    this.freeBuffer_(buffer);
    const namePtr = this.wasmModule.getValue(resultAddress, "i32");
    const numPtr = this.wasmModule.getValue(resultAddress + 4, "i32");
    const datePtr = this.wasmModule.getValue(resultAddress + 8, "i32");
    const cvvPtr = this.wasmModule.getValue(resultAddress + 12, "i32");
    return parseCreditCardCallback(2, namePtr, numPtr, datePtr, cvvPtr);
  }

  processFrame(bitmap) {
   const blob = this.convertBitmapToBlob_(bitmap);
   const buffer = this.createBuffer_(bitmap);
   
    this.wasmModule.HEAPU8.set(blob.data, buffer);
    this.wasmModule.ccall(
      "creditCardProcessFrame",
      null,
      ["number", "number", "number"],
      [buffer, bitmap.width, bitmap.height]
    );

    if (this.frameCount % this.lcdDetectionInterval === 0) {
      this.lcdResult = this.detectLCD(bitmap);
    }
    this.frameCount++;

    this.freeBuffer_(buffer);
  }

  release() {
    this.wasmModule.ccall("release");
  }

  destroy() {
    this.wasmModule.ccall("release");
  }

  releaseCallback() {
    this.wasmModule.removeFunction(this.callback);
    this.callback = null;
  }
  lcdStatus() {
    return this.lcdResult;
  }
}
