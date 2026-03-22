/**
 * Stub for `file-type` in RSC/workerd environments.
 *
 * `file-type` uses Node.js fs/stream APIs unavailable in workerd.
 * Payload CMS transitively depends on it via `@payloadcms/db-d1-sqlite`
 * but doesn't invoke file-type detection during RSC rendering.
 */

export async function fileTypeFromBuffer() {
	return undefined;
}

export async function fileTypeFromBlob() {
	return undefined;
}

export async function fileTypeFromStream() {
	return undefined;
}

export async function fileTypeFromFile() {
	return undefined;
}

export async function fileTypeFromTokenizer() {
	return undefined;
}

export function fileTypeStream() {
	return undefined;
}

export const supportedExtensions = new Set<string>();
export const supportedMimeTypes = new Set<string>();

export class FileTypeParser {
	async fromBuffer() {
		return undefined;
	}
	async fromBlob() {
		return undefined;
	}
	async fromStream() {
		return undefined;
	}
	async fromFile() {
		return undefined;
	}
	async fromTokenizer() {
		return undefined;
	}
	async toDetectionStream() {
		return undefined;
	}
}
