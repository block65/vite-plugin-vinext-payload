import { readFile } from "node:fs/promises";
import { logger } from "./logger.ts";

export async function tryRead(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		logger.trace(`read failed: ${path}`, err);
		return undefined;
	}
}
