/**
 * Minimal local declaration for `@deepseek-ai/schemastery` 3.x.
 *
 * The published package ships its declarations under `lib/types`, which the
 * DSH application archive strips. The runtime bundle is present, and Cordis
 * only needs the Standard Schema callable shape, so this file mirrors the
 * subset the plugin uses. Keep it structural: a schema is a callable that
 * validates and fills defaults.
 */
declare module '@deepseek-ai/schemastery' {
  export interface Schema<T = unknown> {
    (value: unknown): T
    readonly type: string
    default(value: T): Schema<T>
    required(): Schema<T>
    description(text: string): Schema<T>
    hidden(): Schema<T>
    role(text: string): Schema<T>
    min(value: number): Schema<T>
    max(value: number): Schema<T>
    step(value: number): Schema<T>
  }

  export interface ObjectSchema<T extends Record<string, unknown> = Record<string, unknown>> extends Schema<T> {
    toString(): string
  }

  export interface SchemaFactory {
    <T = unknown>(type: string): Schema<T>
    any<T = unknown>(): Schema<T>
    never(): Schema<never>
    const<T>(value: T): Schema<T>
    string(): Schema<string>
    number(): Schema<number>
    natural(): Schema<number>
    percent(): Schema<number>
    boolean(): Schema<boolean>
    array<T>(inner: Schema<T>): Schema<T[]>
    dict<T>(inner: Schema<T>): Schema<Record<string, T>>
    tuple<T extends unknown[]>(items: { [K in keyof T]: Schema<T[K]> }): Schema<T>
    union<T>(values: readonly T[] | (() => readonly T[])): Schema<T>
    object<T extends Record<string, unknown>>(shape: { [K in keyof T]: Schema<T[K]> }): ObjectSchema<T>
    intersect<T extends unknown[]>(schemas: { [K in keyof T]: Schema<T[K]> }): Schema<T[number]>
    transform<T>(inner: Schema<unknown>, transform: (value: unknown) => T): Schema<T>
  }

  const Schema: SchemaFactory
  export default Schema
}
