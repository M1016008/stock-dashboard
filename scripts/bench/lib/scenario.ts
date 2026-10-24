import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FixtureSpec } from './fixture-utils'
import type { SyntheticRuntime } from '../../lib/synthetic-isolation'

export type Tree = 'baseline' | 'after'

export interface RouteResponse {
  readonly status: number
  readonly bodyText: string
  readonly headers: Readonly<Record<string, string>>
  /**
   * Groups responses that must be byte-comparable between trees. A scenario
   * that rotates through several URLs returns one stable key per URL.
   */
  readonly key?: string
}

export interface CallRouteOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
  /** Dynamic route segments, e.g. { ticker: '7203' }. */
  readonly params?: Readonly<Record<string, string | string[]>>
  readonly key?: string
}

/** Everything a scenario may touch while it runs inside a worker process. */
export interface WorkerContext {
  readonly tree: Tree
  readonly codeRoot: string
  readonly runtime: SyntheticRuntime
  /** Dynamic import of a module inside the tree under test (path relative to codeRoot). */
  importFromRoot<T = Record<string, unknown>>(relativePath: string): Promise<T>
  /** Invoke an app/api route handler in-process, exactly like the existing route tests do. */
  callRoute(routeFile: string, url: string, options?: CallRouteOptions): Promise<RouteResponse>
}

export interface BenchScenario {
  /** Globally unique, slash-separated, e.g. 'jp-screener/default-first-page'. */
  readonly id: string
  readonly title: string
  /** P-A: JP/US normal screeners, 24-month, 6-stage, Analog, integrated. */
  readonly priority: 'A' | 'B'
  readonly market: 'JP' | 'US' | 'BOTH'
  readonly fixture: FixtureSpec
  /**
   * Scenarios sharing a prepareKey share one prepared master per tree. The
   * default preparation only runs the tree's own ensureReady() (schema DDL).
   */
  readonly prepareKey?: string
  /** Tree-specific, untimed preparation (e.g. build a serving cache with the tree's own code). */
  prepare?(context: WorkerContext): Promise<void>
  /** One logical request. Timed. Must be deterministic for a given iteration. */
  request(context: WorkerContext, iteration: number): Promise<RouteResponse>
  /** Concurrency levels for the in-process parallel matrix. Default [1, 4, 8]. */
  readonly concurrency?: readonly number[]
  /** Warm requests per cold process. Default 10. */
  readonly warmPerProcess?: number
  /** Number of fresh-process cold samples. Default 8. */
  readonly coldSamples?: number
  /**
   * Remove fields that are volatile by construction (timestamps, elapsed times).
   * Every stripped path must be justified in `normalizeNotes`; nothing that
   * carries a result value may be stripped.
   */
  normalize?(body: unknown): unknown
  readonly normalizeNotes?: string
  /** Optional lightweight projection used only for human-readable equivalence reports. */
  describe?(body: unknown): Record<string, unknown>
  readonly notes?: string
}

export async function importFromRoot<T = Record<string, unknown>>(codeRoot: string, relativePath: string): Promise<T> {
  return await import(pathToFileURL(path.join(codeRoot, relativePath)).href) as T
}

/** Scenario files export `scenarios: BenchScenario[]`. */
export interface ScenarioModule {
  readonly scenarios: readonly BenchScenario[]
}
