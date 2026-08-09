/**
 * @tesseract.js-data/eng ships no type declarations of its own. It exports a fixed
 * shape consumed only by TesseractOcrEngine (see pdf-ocr.ts) to point tesseract.js at
 * the bundled, offline English model instead of its default CDN download.
 */
declare module "@tesseract.js-data/eng" {
	const data: {
		readonly code: string;
		readonly gzip: boolean;
		readonly langPath: string;
	};
	export default data;
}
