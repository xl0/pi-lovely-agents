import { resolve } from "node:path"

const TASK_UPDATE_ROUTES_SYMBOL = Symbol.for("@xl0/pi-lovely-agents/task-update-routes/v1")
type TaskUpdateRoute = () => void | Promise<void>

/** Subscribes to process-local durable state/output changes for one exact parent. */
export function bindTaskUpdateRoute(cwd: string, parentSessionId: string, route: TaskUpdateRoute): () => void {
	const registry = taskUpdateRoutes()
	const key = taskUpdateKey(cwd, parentSessionId)
	const routes = registry.get(key) ?? new Set<TaskUpdateRoute>()
	routes.add(route)
	registry.set(key, routes)
	return () => {
		routes.delete(route)
		if (routes.size === 0 && registry.get(key) === routes) registry.delete(key)
	}
}

/** Requests an event-driven refresh without waiting for UI work. */
export function publishTaskUpdate(cwd: string, parentSessionId: string): void {
	for (const route of [...(taskUpdateRoutes().get(taskUpdateKey(cwd, parentSessionId)) ?? [])])
		void Promise.resolve()
			.then(route)
			.catch(() => {})
}

/** Capacity and tuple gates are process-wide, so every open task panel may change. */
export function publishSchedulerUpdate(): void {
	for (const routes of taskUpdateRoutes().values()) {
		for (const route of [...routes])
			void Promise.resolve()
				.then(route)
				.catch(() => {})
	}
}

function taskUpdateRoutes(): Map<string, Set<TaskUpdateRoute>> {
	const global = globalThis as typeof globalThis & { [TASK_UPDATE_ROUTES_SYMBOL]?: Map<string, Set<TaskUpdateRoute>> }
	global[TASK_UPDATE_ROUTES_SYMBOL] ??= new Map()
	return global[TASK_UPDATE_ROUTES_SYMBOL]
}

function taskUpdateKey(cwd: string, parentSessionId: string): string {
	return `${resolve(cwd)}\0${parentSessionId}`
}
