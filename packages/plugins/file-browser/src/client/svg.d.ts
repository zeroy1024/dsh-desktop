/** SVG imports are converted to trusted text by the shared client bundle loader. */
declare module '*.svg' {
  const source: string
  export default source
}
