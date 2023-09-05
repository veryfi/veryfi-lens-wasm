import DeviceUUID from "./src/device-uuid.js";
import FingerprintID from "./src/fingerprint-id.js";
import { WasmWrapper } from "./src/wasm/wasm.js";
let script = document.createElement("script");
script.src = "./wasm/opencv.js";
document.body.appendChild(script);

const VeryfiLens = (function () {
  const DEFAULT_BOX_COlOR = "rgba(84, 192, 139, 0.6)";
  const DEFAULT_SCALE = 1.0;
  const INTERVAL = 250;
  const LENS_DEVICE_ID_SEPARATOR = "LENS_DEVICE_ID";
  const LENS_SESSION_KEY_SEPARATOR = "LENS_SESSION_KEY";
  const MAX_SHAPE = 512.0;
  const SOCKET_URL = "wss://lens.veryfi.com/ws/crop";
  const VALIDATE_URL = "https://lens.veryfi.com/rest/validate_partner";
  const SOCKET_STATUSES = [
    {
      value: 0,
      state: "CONNECTING",
    },
    {
      value: 1,
      state: "OPEN",
    },
    {
      value: 2,
      state: "CLOSING",
    },
    {
      value: 3,
      state: "CLOSED",
    },
    {
      value: -1,
      state: "UNDEFINED",
    },
  ];

  let device_fingerprint;
  let boxRef = null;
  let cropImgRef = null;
  let frameRef = null;
  let videoRef = null;
  let intervalRef = null;
  let userAgent = null;
  let device_uuid = null;
  let fullSizeImage;
  let wasmWrapper = null;
  let finalImage;

  let previewData = null;
  let boxColor = DEFAULT_BOX_COlOR;
  let clientId = "";
  let coordinates = [];
  let currentFrame = "";
  let isStitchingProcess = false;
  let isDocumentProcess = false;
  let isInitialized = false;
  let hasCoordinates = false;
  let hasInit = false;
  let image = "";
  let isDocument = false;
  let isSocketBusy = false;
  let lensSessionKey = "";
  let scale = DEFAULT_SCALE;
  let ws = null;
  let blurStatus = "";
  let variance;
  let shouldUpdatePreview = false;

  const releaseCanvas = (canvas) => {
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    ctx && ctx.clearRect(0, 0, 1, 1);
  };

  function waitForElement(selector) {
    return new Promise((resolve) => {
      if (document.querySelector(selector)) {
        return resolve(document.querySelector(selector));
      }

      const observer = new MutationObserver((mutations) => {
        if (document.querySelector(selector)) {
          resolve(document.querySelector(selector));
          observer.disconnect();
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    });
  }

  const setClientId = (key) => {
    clientId = key;
  };

  const setCoordinates = (state) => {
    coordinates = state;
  };

  const setCurrentFrame = (state) => {
    currentFrame = state;
  };

  const setHasCoordinates = (state) => {
    hasCoordinates = state;
  };

  const setIsDocument = (state) => {
    isDocument = state;
  };

  const socketInitializer = async () => {
    const connectionId = Date.now();
    ws = new WebSocket(`${SOCKET_URL}/${connectionId}`);
    ws.onmessage = function (event) {
      const payload = JSON.parse(event.data);
      switch (payload.event) {
        case "connect":
          isSocketBusy = false;
          console.log("[EVENT] Started sending frames");
          break;
        case "cropped":
          isSocketBusy = false;
          console.log("[EVENT] Got cropped contours");
          if (payload.data.is_receipt === false) {
            const video = videoRef;
            let boxCanvas = boxRef;
            if (video && boxCanvas) {
              boxCanvas.width = video.videoWidth;
              boxCanvas.height = video.videoHeight;
              const ctx = boxCanvas.getContext("2d");
              if (ctx) ctx.restore();
            }
            setHasCoordinates(false);
            return;
          }
          const rCorners = payload.data.contours.map((corner) =>
            corner.map((cord) => cord / scale)
          );
          drawContours(rCorners);
          coordinates = rCorners;
          break;
        default:
          isSocketBusy = false;
          console.log("[EVENT] Unknown event");
      }
    };
  };

  const displayVideo = () => {
    const video = videoRef;
    const frameCanvas = frameRef;
    if (video && frameCanvas) {
      frameCanvas.width = video.videoWidth;
      frameCanvas.height = video.videoHeight;
      const ctx = frameCanvas.getContext("2d");
      if (ctx) ctx.drawImage(video, 0, 0);
    }
  };

  const sendFrame = () => {
    if (isSocketBusy) return;
    const video = videoRef;
    const frameCanvas = frameRef;
    if (video && frameCanvas) {
      let videoHeight = Number(video.videoHeight);
      let videoWidth = Number(video.videoWidth);

      const fullSizeCanvas = document.createElement("canvas");
      fullSizeCanvas.width = videoWidth;
      fullSizeCanvas.height = videoHeight;
      const fullSizeCtx = fullSizeCanvas.getContext("2d");

      if (fullSizeCtx) {
        fullSizeCtx.save();
        fullSizeCtx.drawImage(video, 0, 0, videoWidth, videoHeight);
        fullSizeCtx.restore();
        const imgString = fullSizeCanvas.toDataURL("image/jpeg");

        fullSizeImage = new Image();
        fullSizeImage.src = imgString;
      }

      if (videoWidth > videoHeight) {
        if (videoWidth > MAX_SHAPE) {
          scale = MAX_SHAPE / videoWidth;
          videoHeight = videoHeight * scale;
          videoWidth = MAX_SHAPE;
        }
      } else {
        if (videoHeight > MAX_SHAPE) {
          scale = MAX_SHAPE / videoHeight;
          videoWidth = videoWidth * scale;
          videoHeight = MAX_SHAPE;
        }
      }
      frameCanvas.width = videoWidth;
      frameCanvas.height = videoHeight;
      const ctx = frameCanvas.getContext("2d");

      if (ctx) {
        ctx.save();
        ctx.drawImage(video, 0, 0, videoWidth, videoHeight);
        ctx.restore();
      }
      const imgString = frameCanvas.toDataURL("image/jpeg");
      const payload = imgString.split("data:image/jpeg;base64,")[1];
      setCurrentFrame(payload);

      if (ws.readyState === 1) {
        isSocketBusy = true;
        ws.send(
          getDeviceID(device_uuid, device_fingerprint) +
            LENS_DEVICE_ID_SEPARATOR +
            lensSessionKey +
            LENS_SESSION_KEY_SEPARATOR +
            payload
        );
      }
      releaseCanvas(frameCanvas);
    }
  };

  const getVideo = () => {
    const isDesktop = window.screen.width > window.screen.height;
    if (navigator) {
      navigator.mediaDevices
        .getUserMedia({
          video: {
            aspectRatio: isDesktop ? 9 / 16 : 16 / 9,
            facingMode: "environment",
            width: { ideal: 2160 },
            height: { ideal: 4096 },
          },
        })
        .then((stream) => {
          console.log("started stream");
          const video = videoRef;
          video.srcObject = stream;
        })
        .catch((err) => {
          console.log(`[Event] Error: ${err}`);
        });
    }
  };

  const getVideoWasmLong = () => {
    const camWidth = 1080;
    const camHeight = 1920;
    const isDesktop = window.screen.width > window.screen.height;
    if (navigator) {
      console.log("User agent is present");
      navigator.mediaDevices
        .getUserMedia({
          video: {
            aspectRatio: isDesktop ? 9 / 16 : 16 / 9,
            facingMode: "environment",
            width: { ideal: camWidth },
            height: { ideal: camHeight },
          },
        })
        .then((stream) => {
          const video = videoRef;
          video.srcObject = stream;
          wasmWrapper.setStitcherCallback(logLongDocument);
        })
        .catch((err) => {
          console.log(`[Event] Error: ${err}`);
        });
    } else console.log("No user agent");
  };

  const getVideoWasm = () => {
    const camWidth = 2160;
    const camHeight = 4096;
    const isDesktop = window.screen.width > window.screen.height;
    if (navigator) {
      console.log("User agent is present");
      navigator.mediaDevices
        .getUserMedia({
          video: {
            aspectRatio: isDesktop ? 9 / 16 : 16 / 9,
            facingMode: "environment",
            width: { ideal: camWidth },
            height: { ideal: camHeight },
          },
        })
        .then((stream) => {
          const video = videoRef;
          video.srcObject = stream;
          wasmWrapper.setDocumentCallback(logDocument);
        })
        .catch((err) => {
          console.log(`[Event] Error: ${err}`);
        });
    } else console.log("No user agent");
  };

  const loadImage = (src) => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  };

  const sendWasm = async (mode) => {
    if (isDocumentProcess) {
      mode = "Document";
    } else
      isStitchingProcess ? (mode = "Stitcher") : (mode = "StitcherProcess");
    if (videoRef) {
      let rCorners;
      const video = videoRef;
      let videoHeight = Number(video.videoHeight);
      let videoWidth = Number(video.videoWidth);
      const fullSizeCanvas = document.createElement("canvas");
      fullSizeCanvas.width = videoWidth;
      fullSizeCanvas.height = videoHeight;
      const fullSizeCtx = fullSizeCanvas.getContext("2d");

      if (fullSizeCtx) {
        fullSizeCtx.save();
        fullSizeCtx.drawImage(video, 0, 0, videoWidth, videoHeight);
        fullSizeCtx.restore();
        const imgString = fullSizeCanvas.toDataURL("image/jpeg");

        try {
          fullSizeImage = await loadImage(imgString);
          createImageBitmap(fullSizeImage).then((bitmap) => {
            fullSizeImage = bitmap;
            wasmWrapper.processDocument(bitmap, mode);
            rCorners = coordinates.map((corner) =>
              corner.map((cord) => cord / scale)
            );
            if (
              rCorners.length &&
              rCorners.some((subArr) => subArr.reduce((a, b) => a + b, 0) !== 0)
            ) {
              drawContours(rCorners);
              if (previewData !== null && shouldUpdatePreview) {
                updatePreview(
                  previewData.data,
                  previewData.outputWidth,
                  previewData.outputHeight
                );
              }
            } else {
              setHasCoordinates(false);
            }
          });
        } catch (error) {
          console.error(error);
        }

        releaseCanvas(fullSizeCanvas);
        releaseCanvas(boxRef);
      }
    }
  };

  const getLongImage = async () => {
    let wasmOutput;
    wasmOutput = await wasmWrapper.getStitchedImage();
    const { data, blurLevel, outputHeight, outputWidth } = wasmOutput;
    // console.log(blurLevel)
    const width = outputWidth;
    const height = outputHeight;
    const cropImgCanvas = cropImgRef;
    cropImgRef.height = height;
    cropImgRef.width = width;
    const ctx = cropImgCanvas.getContext("2d");
    const imageData = new ImageData(data, width, height);
    ctx.putImageData(imageData, 0, 0);
    // setBlurStatus(blurLevel); gives 0 all the time
    stopWasm();
    const imgString = cropImgCanvas.toDataURL("image/jpeg");
    image = cropImgCanvas;
    releaseCanvas(boxRef);
    coordinates = [];
    return imgString.split("data:image/jpeg;base64,")[1];
  };

  function updatePreview(data, originalWidth, originalHeight) {
    shouldUpdatePreview = false;
    const container = document.getElementById("preview-container");
    let width;
    let height;
    if (container) {
      width = container.clientWidth;
      height = container.clientHeight;
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = width;
    canvas.height = height;

    // Create a temporary canvas to draw the original image
    const tempCanvas = document.createElement("canvas");
    const tempContext = tempCanvas.getContext("2d");
    tempCanvas.width = originalWidth;
    tempCanvas.height = originalHeight;

    // Create the original ImageData and draw it to the temporary canvas
    let originalImageData = new ImageData(data, originalWidth, originalHeight);
    tempContext.putImageData(originalImageData, 0, 0);

    // Draw the image from the temporary canvas to the main canvas, resizing it in the process
    context.drawImage(
      tempCanvas,
      0,
      0,
      originalWidth,
      originalHeight,
      0,
      0,
      width,
      height
    );

    while (container?.firstChild) {
      container.removeChild(container.firstChild);
    }
    container.appendChild(canvas);
  }

  function logDocument(status, x0, y0, x1, y1, x2, y2, x3, y3) {
    coordinates = [
      [x0, y0],
      [x1, y1],
      [x2, y2],
      [x3, y3],
    ];
    // console.log(coordinates)
  }
  function logLongDocument(
    status,
    x0,
    y0,
    x1,
    y1,
    x2,
    y2,
    x3,
    y3,
    previewAddress
  ) {
    coordinates = [
      [x0, y0],
      [x1, y1],
      [x2, y2],
      [x3, y3],
    ];
    previewData = wasmWrapper.getResultFromBuffer(previewAddress);
    shouldUpdatePreview = status == 0;
  }

  const drawContours = (contours) => {
    const video = videoRef;
    const BoxCanvas = boxRef;

    if (video && BoxCanvas) {
      BoxCanvas.width = video.videoWidth;
      BoxCanvas.height = video.videoHeight;
      let ctx = BoxCanvas.getContext("2d");

      if (ctx) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(contours[0][0], contours[0][1]);
        ctx.lineTo(contours[1][0], contours[1][1]);
        ctx.lineTo(contours[2][0], contours[2][1]);
        ctx.lineTo(contours[3][0], contours[3][1]);
        ctx.fillStyle = boxColor;
        ctx.fill();
        setCoordinates(contours);
        setHasCoordinates(true);
        ctx.restore();
      }
    }
  };

  const cropWasm = async () => {
    let wasmOutput;
    if (hasCoordinates) {
      wasmOutput = await wasmWrapper.cropDocument(fullSizeImage);
    } else {
      // If there are no coordinates, use the fullSizeImage as it is.
      const canvas = new OffscreenCanvas(
        fullSizeImage.width,
        fullSizeImage.height
      );
      const ctx = canvas.getContext("2d");
      ctx.drawImage(fullSizeImage, 0, 0);
      const imageData = ctx.getImageData(
        0,
        0,
        fullSizeImage.width,
        fullSizeImage.height
      );
      wasmOutput = {
        data: new Uint8ClampedArray(imageData.data.buffer),
        blurLevel: -1.0,
        outputWidth: fullSizeImage.width,
        outputHeight: fullSizeImage.height,
      };
    }
    console.log(wasmOutput);
    const { data, blurLevel, outputHeight, outputWidth } = wasmOutput;
    console.log(outputWidth, outputHeight);
    const width = outputWidth;
    const height = outputHeight;
    const cropImgCanvas = cropImgRef;
    cropImgRef.height = height;
    cropImgRef.width = width;
    const ctx = cropImgCanvas.getContext("2d");
    const imageData = new ImageData(data, width, height);
    ctx.putImageData(imageData, 0, 0);
    setBlurStatus(blurLevel);
    stopWasm();

    const imgString = cropImgCanvas.toDataURL("image/jpeg");
    image = cropImgCanvas;
    releaseCanvas(boxRef);
    coordinates = [];
    return imgString.split("data:image/jpeg;base64,")[1];
  };

  const socketCropWasm = async () => {
    let wasmOutput;
    if (hasCoordinates) {
      let [topLeft, topRight, bottomLeft, bottomRight] =
        getCropLimits(coordinates);
      wasmOutput = await wasmWrapper.cropWasm(
        fullSizeImage,
        [topLeft, topRight, bottomLeft, bottomRight].flat()
      );
    } else {
      // If there are no coordinates, use the fullSizeImage as it is.
      const canvas = new OffscreenCanvas(
        fullSizeImage.width,
        fullSizeImage.height
      );
      const ctx = canvas.getContext("2d");
      ctx.drawImage(fullSizeImage, 0, 0);
      const imageData = ctx.getImageData(
        0,
        0,
        fullSizeImage.width,
        fullSizeImage.height
      );
      wasmOutput = {
        data: new Uint8ClampedArray(imageData.data.buffer),
        blurLevel: -1.0,
        outputWidth: fullSizeImage.width,
        outputHeight: fullSizeImage.height,
      };
    }
    console.log(wasmOutput);
    const { data, blurLevel, outputHeight, outputWidth } = wasmOutput;
    console.log(outputWidth, outputHeight);
    const width = outputWidth;
    const height = outputHeight;
    const cropImgCanvas = cropImgRef;
    cropImgRef.height = height;
    cropImgRef.width = width;
    const ctx = cropImgCanvas.getContext("2d");
    const imageData = new ImageData(data, width, height);
    ctx.putImageData(imageData, 0, 0);
    setBlurStatus(blurLevel);

    stopWasm();

    const imgString = cropImgCanvas.toDataURL("image/jpeg");
    image = cropImgCanvas;
    releaseCanvas(boxRef);
    coordinates = [];
    return imgString.split("data:image/jpeg;base64,")[1];
  };

  // const cropImage = async () => {
  //   const video = videoRef;
  //   const cropImgCanvas = cropImgRef;
  //   if (fullSizeImage) {
  //     console.log("[Event] Full size image is set");
  //     if (hasCoordinates) {
  //       setIsDocument(true);
  //       let { sx, sy, sw, sh } = getCropLimits(coordinates);
  //       const scaleWidth = fullSizeImage.width / video.videoWidth;
  //       const scaleHeight = fullSizeImage.height / video.videoHeight;

  //       sx = sx * scaleWidth;
  //       sy = sy * scaleHeight;
  //       sw = sw * scaleWidth;
  //       sh = sh * scaleHeight;

  //       cropImgCanvas.width = sw;
  //       cropImgCanvas.height = sh;
  //       const ctx = cropImgCanvas.getContext("2d");

  //       if (ctx) {
  //         ctx.save();
  //         ctx.drawImage(fullSizeImage, sx, sy, sw, sh, 0, 0, sw, sh);
  //         ctx.restore();
  //       }
  //     } else {
  //       cropImgCanvas.width = video.videoWidth;
  //       cropImgCanvas.height = video.videoHeight;
  //       const ctx = cropImgCanvas.getContext("2d");
  //       if (ctx) {
  //         ctx.save();
  //         ctx.drawImage(fullSizeImage, 0, 0);
  //         ctx.restore();
  //       }
  //     }
  //   } else {
  //     if (hasCoordinates) {
  //       setIsDocument(true);
  //       let { sx, sy, sw, sh } = getCropLimits(coordinates);
  //       cropImgCanvas.width = sw;
  //       cropImgCanvas.height = sh;
  //       const ctx = cropImgCanvas.getContext("2d");
  //       if (ctx) {
  //         ctx.save();
  //         ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  //         ctx.restore();
  //       }
  //     } else {
  //       cropImgCanvas.width = video.videoWidth;
  //       cropImgCanvas.height = video.videoHeight;
  //       const ctx = cropImgCanvas.getContext("2d");
  //       if (ctx) {
  //         ctx.save();
  //         ctx.drawImage(video, 0, 0);
  //         ctx.restore();
  //       }
  //     }
  //   }

  //   waitForElement("#blur-detector").then(() => {
  //     isBlurry(cropImgCanvas);
  //   });

  //   image = cropImgCanvas;
  //   const imgString = cropImgCanvas.toDataURL("image/jpeg");

  //   return imgString.split("data:image/jpeg;base64,")[1];
  // };

  const getCropLimits = (coordinates) => {
    const sx = Math.min(
      coordinates[0][0],
      coordinates[1][0],
      coordinates[2][0],
      coordinates[3][0]
    );
    const sy = Math.min(
      coordinates[0][1],
      coordinates[1][1],
      coordinates[2][1],
      coordinates[3][1]
    );
    const sw =
      Math.max(
        coordinates[0][0],
        coordinates[1][0],
        coordinates[2][0],
        coordinates[3][0]
      ) - sx;
    const sh =
      Math.max(
        coordinates[0][1],
        coordinates[1][1],
        coordinates[2][1],
        coordinates[3][1]
      ) - sy;

    const topLeft = [sx, sy];
    const topRight = [sx + sw, sy];
    const bottomLeft = [sx, sy + sh];
    const bottomRight = [sx + sw, sy + sh];
    // return { sx, sy, sw, sh }; uncomment to use non wasm crop function (cropImage())
    return [topLeft, topRight, bottomLeft, bottomRight];
  };

  const fetchSessionId = async (clientId) => {
    return await fetch(VALIDATE_URL, {
      method: "POST",
      headers: {
        "CLIENT-ID": clientId,
      },
    })
      .then((response) => {
        if (response.ok) {
          return response.json();
        }
        throw new Error("Wrong client id");
      })
      .then((response) => {
        return response.session;
      })
      .catch((error) => {
        console.log("[EVENT] " + error);
      });
  };

  const stopLens = () => {
    ws.close();
    videoRef.srcObject.getTracks().forEach((track) => track.stop());
    clearInterval(intervalRef);
  };
  const stopWasm = () => {
    videoRef.srcObject.getTracks().forEach((track) => track.stop());
    clearInterval(intervalRef);
  };

  const createElement = (type, id, classes, container) => {
    const element = document.createElement(type);
    element.setAttribute("id", id);
    element.className += classes;
    container.appendChild(element);
  };

  const getDeviceID = (uuid, fingerprint) => {
    return `${uuid + fingerprint}`.replace(/\-/g, "");
  };

  const startWasm = async () => {
    wasmWrapper = new WasmWrapper();
    await wasmWrapper.initialize();
    if (wasmWrapper) {
      getVideoWasm();
      requestAnimationFrame(displayVideo);
      intervalRef = setInterval(() => {
        sendWasm("Document");
      }, INTERVAL);
      return () => {
        clearInterval(intervalRef);
      };
    }
  };
  const startWasmLong = async () => {
    wasmWrapper = new WasmWrapper();
    await wasmWrapper.initialize();
    if (wasmWrapper) {
      getVideoWasmLong();
      requestAnimationFrame(displayVideo);
      intervalRef = setInterval(() => {
        sendWasm("StitcherProcess");
      }, INTERVAL);
      return () => {
        clearInterval(intervalRef);
      };
    }
  };

  const startLens = async () => {
    await socketInitializer().then(() => {
      console.log("[EVENT] Socket Initialized");
    });
    getVideo();
    requestAnimationFrame(displayVideo);
    intervalRef = setInterval(() => {
      requestAnimationFrame(sendFrame);
    }, INTERVAL);
    return () => {
      clearInterval(intervalRef);
    };
  };

  const setBlurStatus = (variance) => {
    if (variance >= 10) {
      blurStatus = false;
      return { blurStatus, variance };
    } else if (variance < 0) {
      blurStatus = false;
      console.log(
        "Variance is lower than 0, Which means image was not cropped and did not pass through blur detection"
      );
      return { blurStatus, variance };
    } else {
      blurStatus = true;
      return { blurStatus, variance };
    }
  };

  // const isBlurry = async (image) => {
  //   console.log("[EVENT] Checking for blur");
  //   const src = cv.imread(image);
  //   let refVariance;
  //   let whiteCanvas = new cv.Mat(490, 866, cv.CV_8UC3, [255, 255, 255, 0]);

  //   const grayscale = new cv.Mat();
  //   const refGrayscale = new cv.Mat();

  //   cv.cvtColor(src, grayscale, cv.COLOR_RGBA2GRAY);
  //   cv.cvtColor(whiteCanvas, refGrayscale, cv.COLOR_RGBA2GRAY);

  //   const laplacian = new cv.Mat();
  //   const refLaplacian = new cv.Mat();

  //   cv.Laplacian(grayscale, laplacian, cv.CV_8U);
  //   cv.Laplacian(refGrayscale, refLaplacian, cv.CV_8U);

  //   const meanStdDev = new cv.Mat();
  //   const laplacianMean = new cv.Mat();
  //   const refMeanStdDev = new cv.Mat();
  //   const refLaplacianMean = new cv.Mat();

  //   cv.meanStdDev(laplacian, laplacianMean, meanStdDev);
  //   cv.meanStdDev(refLaplacian, refLaplacianMean, refMeanStdDev);

  //   variance = meanStdDev.data64F[0] * 10;
  //   refVariance = refMeanStdDev.data64F[0] * 10;

  //   console.log("variance", variance);
  //   console.log("reference variance", refVariance);

  //   grayscale.delete();
  //   laplacian.delete();
  //   meanStdDev.delete();
  //   laplacianMean.delete();
  //   refGrayscale.delete();
  //   refLaplacian.delete();
  //   refMeanStdDev.delete();
  //   refLaplacianMean.delete();
  //   whiteCanvas.delete();

  //   if (variance > 88) {
  //     blurStatus = false;
  //     setBlurStatus(blurStatus, variance);
  //     return;
  //   } else {
  //     blurStatus = true;
  //     setBlurStatus(blurStatus, variance);
  //     return;
  //   }
  // };

  return {
    init: async (session) => {
      const fp = await FingerprintID.load();
      device_fingerprint = (await fp.get()).visitorId;
      userAgent = navigator.userAgent;
      device_uuid = new DeviceUUID(userAgent).get();
      console.log(
        "[EVENT] Device ID",
        getDeviceID(device_uuid, device_fingerprint)
      );
      if (session) lensSessionKey = session;
      const container = document.getElementById("veryfi-container");
      const generalClasses = "absolute sm:rounded-md h-full max-w-none";
      const frameClasses = "absolute invisible sm:rounded-md h-full max-w-none";
      const cropImgClasses = "absolute sm:rounded-md h-full max-w-none z-30";

      createElement(
        "canvas",
        "veryfi-crop-img-ref",
        [cropImgClasses],
        container
      );
      createElement("canvas", "veryfi-frame-ref", frameClasses, container);
      createElement(
        "video",
        "veryfi-video-ref",
        `${generalClasses} z-10`,
        container
      );
      createElement(
        "canvas",
        "veryfi-box-ref",
        `${generalClasses} z-10`,
        container
      );

      videoRef = document.getElementById("veryfi-video-ref");
      const video = videoRef;
      video.playsInline = true;
      video.preload = "metadata";
      video.autoplay = true;
      frameRef = document.getElementById("veryfi-frame-ref");
      boxRef = document.getElementById("veryfi-box-ref");
      cropImgRef = document.getElementById("veryfi-crop-img-ref");
      startLens();
      wasmWrapper = new WasmWrapper();
      await wasmWrapper.initialize();
    },
    initWasm: async (session) => {
      isDocumentProcess = true;
      const fp = await FingerprintID.load();
      device_fingerprint = (await fp.get()).visitorId;
      userAgent = navigator.userAgent;
      device_uuid = new DeviceUUID(userAgent).get();
      console.log(
        "[EVENT] Device ID",
        getDeviceID(device_uuid, device_fingerprint)
      );

      if (session) lensSessionKey = session;
      const container = document.getElementById("veryfi-container");
      const generalClasses = "absolute sm:rounded-md h-full max-w-none";
      const cropImgClasses = "absolute sm:rounded-md h-full max-w-none z-30";

      createElement(
        "canvas",
        "veryfi-crop-img-ref",
        [cropImgClasses],
        container
      );
      createElement("canvas", "veryfi-frame-ref", `hidden`, container);
      createElement(
        "video",
        "veryfi-video-ref",
        `${generalClasses} z-10`,
        container
      );
      createElement(
        "canvas",
        "veryfi-box-ref",
        `${generalClasses} z-10`,
        container
      );

      videoRef = document.getElementById("veryfi-video-ref");
      const video = videoRef;
      video.playsInline = true;
      video.preload = "metadata";
      video.autoplay = true;
      frameRef = document.getElementById("veryfi-frame-ref");
      boxRef = document.getElementById("veryfi-box-ref");
      cropImgRef = document.getElementById("veryfi-crop-img-ref");
      startWasm();
    },
    initWasmLong: async (session) => {
      isStitchingProcess = false;
      const fp = await FingerprintID.load();
      device_fingerprint = (await fp.get()).visitorId;
      userAgent = navigator.userAgent;
      device_uuid = new DeviceUUID(userAgent).get();
      console.log(
        "[EVENT] Device ID",
        getDeviceID(device_uuid, device_fingerprint)
      );

      if (session) lensSessionKey = session;
      const container = document.getElementById("veryfi-container");
      const generalClasses = "absolute sm:rounded-md h-full max-w-none";
      const cropImgClasses = "absolute sm:rounded-md h-full max-w-none z-30";

      createElement(
        "canvas",
        "veryfi-crop-img-ref",
        [cropImgClasses],
        container
      );
      createElement("canvas", "veryfi-frame-ref", `hidden`, container);
      createElement(
        "video",
        "veryfi-video-ref",
        `${generalClasses} z-10`,
        container
      );
      createElement(
        "canvas",
        "veryfi-box-ref",
        `${generalClasses} z-10`,
        container
      );

      videoRef = document.getElementById("veryfi-video-ref");
      const video = videoRef;
      video.playsInline = true;
      video.preload = "metadata";
      video.autoplay = true;
      frameRef = document.getElementById("veryfi-frame-ref");
      boxRef = document.getElementById("veryfi-box-ref");
      cropImgRef = document.getElementById("veryfi-crop-img-ref");
      startWasmLong();
    },
    startCamera: () => {
      console.log("[EVENT] startCamera");
      startLens();
    },
    startCameraWasm: () => {
      console.log("[EVENT] startCamera");
      startWasm();
    },
    stopCamera: () => {
      console.log("[EVENT] stopCamera");
      stopLens();
      clearInterval(intervalRef);
    },
    stopCameraWasm: () => {
      console.log("[EVENT] stopCamera");
      stopWasm();

      clearInterval(intervalRef);
    },
    capture: async (setImage, setIsEditing) => {
      console.log("[EVENT] capture");
      const finalImage = await socketCropWasm();
      setImage && setImage(finalImage);
      console.log("[EVENT] hasCoordinates: ", hasCoordinates);
      if (hasCoordinates) setIsDocument(true);
      stopLens();
      setIsEditing && setIsEditing(true);
      return finalImage;
    },
    captureWasm: async (setImage, setIsEditing) => {
      console.log("[EVENT] capture wasm");
      console.log("[EVENT] hasCoordinates: ", hasCoordinates);
      if (hasCoordinates) setIsDocument(true);
      finalImage = await cropWasm();
      setImage && setImage(finalImage);
      stopWasm();
      setIsEditing && setIsEditing(true);
      return finalImage;
    },
    captureLong: async (setImage, setIsEditing) => {
      console.log("[EVENT] capture long");
      finalImage = await getLongImage();
      setIsEditing && setImage(finalImage);
      stopWasm();
      setIsDocument(true);
      setIsEditing && setIsEditing(true);
      return finalImage;
    },
    startStitching: async () => {
      isStitchingProcess = true;
    },
    createNewSession: async (clientId) => {
      await fetchSessionId(clientId);
      setClientId(clientId);
    },
    setUserAgent: (ua) => {
      userAgent = ua;
    },
    getBoxColor: () => {
      return boxColor;
    },
    setBoxColor: (color) => {
      boxColor = color;
    },
    getCroppedImage: () => {
      return image;
    },
    getCoordinates: () => {
      return coordinates;
    },
    getHasCoordinates: () => {
      return hasCoordinates;
    },
    getHasInit: () => {
      return hasInit;
    },
    getIsDocument: () => {
      return isDocument;
    },
    getLensSessionKey: () => {
      return lensSessionKey;
    },
    setLensSessionKey: (key) => {
      lensSessionKey = key;
    },
    getSocketStatus: () => {
      const value = ws?.readyState || 4;
      return SOCKET_STATUSES[value];
    },
    getSocketStatusColor: () => {
      const socketStatusesColors = [
        "yellow",
        "green",
        "orange",
        "red",
        "purple",
      ];
      const value = ws?.readyState || 4;
      return socketStatusesColors[value];
    },
    getBlurStatus: (setIsBlurry) => {
      setIsBlurry && setIsBlurry(blurStatus);
      return {
        blurStatus,
        variance,
      };
    },
    cleanCanvases: () => {
      console.log("Cleaning");
      const box = boxRef;
      const video = videoRef;
      const frame = frameRef;
      const crop = cropImgRef;
      crop && releaseCanvas(crop);
      video?.pause();
      video?.removeAttribute("src");
      video?.load();
      box && releaseCanvas(box);
      frame && releaseCanvas(frame);
      videoRef?.remove();
      frameRef?.remove();
      boxRef?.remove();
      cropImgRef?.remove();
      setIsDocument(false);
    },
  };
})();

export default VeryfiLens;
