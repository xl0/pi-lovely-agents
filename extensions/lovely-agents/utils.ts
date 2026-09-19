import { lstat } from "node:fs/promises"

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code
}

/** True only for a real directory; symlinks never count and a missing path is false. */
export async function isRealDirectory(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory()
	} catch (error) {
		if (hasCode(error, "ENOENT")) return false
		throw error
	}
}

export function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>(resolvePromise => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}
