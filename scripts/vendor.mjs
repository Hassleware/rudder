// `npm install` copies the libraries the extension loads into extension/vendor (no CDN in an extension).
import fs from "node:fs";
const copy = (from, to) => { const dest = "extension/vendor/" + to; fs.mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true }); fs.copyFileSync("node_modules/" + from, dest); };
copy("@huggingface/transformers/dist/transformers.min.js", "transformers.min.js");
copy("onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm", "ort-tjs.wasm");
copy("tesseract.js/dist/tesseract.esm.min.js", "tesseract/tesseract.esm.min.js");
copy("tesseract.js/dist/worker.min.js", "tesseract/worker.min.js");
for (const f of ["tesseract-core-relaxedsimd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"]) copy("tesseract.js-core/" + f, "tesseract/" + f);
copy("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "tesseract/eng.traineddata.gz");
