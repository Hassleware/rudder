// Thumbnail text, read by Tesseract (tesseract.js, vendored by `npm install`) on the processor: about 60 ms a thumbnail,
// no GPU. The words go through the same keyword check as titles (youtube/keywords.js). Chosen on the Rudder test set
// (NOTES.md): keywords on title + Tesseract text caught 78% (title alone 73%). Florence-2 reads better (81%) but takes
// ~0.7 s a thumbnail on the processor, and its GPU version doesn't run in Firefox.
import Tesseract from "./vendor/tesseract/tesseract.esm.min.js";

const url = (p) => browser.runtime.getURL("vendor/tesseract/" + p);
const WORKERS = 2;
let scheduler = null;
function start() {
  scheduler ??= (async () => {
    const s = Tesseract.createScheduler();
    for (let k = 0; k < WORKERS; k++) {
      const w = await Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY, {
        workerPath: url("worker.min.js"), corePath: url(""), langPath: url(""), workerBlobURL: false, gzip: true, cacheMethod: "none",
      });
      s.addWorker(w);
    }
    return s;
  })().catch((err) => { scheduler = null; throw err; });
  return scheduler;
}

// thumbnail bytes → its words (only ones Tesseract is fairly sure of: on photos it otherwise reads noise as letters)
export async function readThumbnail(bytes) {
  const s = await start();
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = new OffscreenCanvas(bmp.width * 2, bmp.height * 2); // thumbnail text is small: twice the size reads better
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const { data } = await s.addJob("recognize", await c.convertToBlob(), {}, { text: false, blocks: true });
  const words = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
  return words.filter((w) => w.confidence >= 60 && /[a-z0-9]{2}/i.test(w.text)).map((w) => w.text).join(" ");
}
