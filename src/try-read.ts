import { readFile } from "node:fs/promises";

export async function tryRead(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}
