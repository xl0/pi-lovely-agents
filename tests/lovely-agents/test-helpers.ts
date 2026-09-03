import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

export type TempWorkspace = {
	root: string
	cwd: string
	agentDir: string
	write(path: string, content: string): Promise<string>
}

export async function withTempWorkspace<T>(run: (workspace: TempWorkspace) => Promise<T> | T): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "lovely-agents-"))
	const cwd = join(root, "workspace")
	const agentDir = join(root, "agent")
	await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })])
	try {
		return await run({
			root,
			cwd,
			agentDir,
			async write(path, content) {
				const target = join(root, path)
				await mkdir(dirname(target), { recursive: true })
				await writeFile(target, content, "utf8")
				return target
			}
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

export function definitionSource(name: string, description = `Description for ${name}`, extra = ""): string {
	return `---\nname: ${name}\ndescription: ${description}${extra}\n---\n\nSystem prompt for ${name}.\n`
}
