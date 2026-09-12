declare module 'papaparse' {
  interface ParseResult<T> { data: T[]; errors: Array<{ message: string }> }
  interface ParseOptions { skipEmptyLines?: boolean | 'greedy' }
  const Papa: { parse<T>(input: string, options?: ParseOptions): ParseResult<T> };
  export default Papa;
}
