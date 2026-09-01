/**
 * File-name routing for source previews and the generated IntelliJ Platform
 * ExpUI asset pack. Preview grammar and icon selection remain independent:
 * adding an icon never changes CodeBlock language behavior.
 */
import type { IconAssetId } from './icon-assets.ts'

export type { IconAssetId } from './icon-assets.ts'

/** CodeBlock/shiki grammar name (undefined means plain rendering). */
export function langFromName(name: string): string | undefined {
  return EXT_LANG[extOf(name)]
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

function basenameOf(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return slash < 0 ? name : name.slice(slash + 1)
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'scss', less: 'less', html: 'html', vue: 'html', svelte: 'html',
  py: 'python', rs: 'rust', go: 'go', java: 'java', c: 'c', h: 'c', cpp: 'cpp',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', toml: 'toml', xml: 'xml', sql: 'sql',
}

/**
 * Resolve every file to an asset in the generated ExpUI pack. Unknown and
 * unsupported names deliberately converge on the official ExpUI `unknown`
 * icon, so no host primitive or locally drawn fallback can re-enter the tree.
 */
export function iconAssetOf(name: string): IconAssetId {
  const base = basenameOf(name).toUpperCase()
  if (LOCK_BASENAMES.has(base) || base.endsWith('.LOCK')) return 'unknown'
  if (base.endsWith('.SCHEMA.JSON')) return 'jsonSchema'
  const asset = EXT_ASSET[extOf(name)]
  if (asset !== undefined) return asset

  if (base === 'DOCKERFILE' || base.startsWith('DOCKERFILE.')) return 'docker'
  if (base === 'JENKINSFILE' || base.startsWith('JENKINSFILE.')) return 'jenkins'
  if (base === '.EDITORCONFIG') return 'editorConfig'
  if (base === '.GITIGNORE' || base === '.GITATTRIBUTES' || base === '.GITMODULES') return 'gitignore'
  if (base === 'BUILD' || base === 'WORKSPACE' || base === 'WORKSPACE.BAZEL'
    || base === 'MODULE.BAZEL') return 'bazel'
  if (base === 'MAKEFILE' || base === 'GNUMAKEFILE' || base === 'GEMFILE'
    || base === 'RAKEFILE' || base === 'JUSTFILE' || base === '.ENV'
    || base.startsWith('.ENV.')) return 'config'
  if (base === 'README' || base.startsWith('README.') || base === 'CHANGELOG'
    || base.startsWith('CHANGELOG.')) return 'markdown'
  if (base === 'LICENSE' || base.startsWith('LICENSE.') || base === 'NOTICE'
    || base.startsWith('NOTICE.') || base === 'COPYING') return 'text'
  if (base === 'MANIFEST.MF') return 'manifest'
  return 'unknown'
}

const EXT_ASSET: Record<string, IconAssetId> = {
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  json: 'json', jsonc: 'json', json5: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'toml',
  ts: 'typeScript', tsx: 'typeScript', cts: 'typeScript', mts: 'typeScript',
  js: 'javaScript', jsx: 'javaScript', mjs: 'javaScript', cjs: 'javaScript',
  css: 'css', scss: 'css', less: 'css', sass: 'css',
  html: 'html', htm: 'html', xhtml: 'xhtml', xml: 'xml', xsd: 'xsd', dtd: 'xml', wsdl: 'wsdl',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ksh: 'shell', csh: 'shell',
  py: 'python', pyw: 'python', go: 'go', rs: 'rust',
  c: 'c', h: 'h', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  cs: 'Csharp', java: 'java', class: 'javaClass', swift: 'swiftLang',
  sql: 'sql', csv: 'csv', tsv: 'csv', groovy: 'groovy', graphql: 'graphql', gql: 'graphql',
  jsp: 'jsp', jspx: 'jspx', ipynb: 'jupyter', mf: 'manifest', pl: 'perl', pm: 'perl',
  properties: 'properties', rst: 'rst', map: 'sourceMap', tf: 'terraform', tfvars: 'terraform',
  form: 'uiForm', vue: 'vue', patch: 'patch', diff: 'patch', http: 'http', iml: 'ideaModule',
  idl: 'idl', hprof: 'hprof', jfr: 'jfr', gradle: 'gradle', bazel: 'bazel', bzl: 'bazel',
  as: 'actionScript', aj: 'aspectJ',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image', ico: 'image',
  bmp: 'image', tif: 'image', tiff: 'image', avif: 'image', heic: 'image',
  bin: 'binaryData', dat: 'binaryData', wasm: 'binaryData', jar: 'binaryData',
  exe: 'microsoftWindows', dll: 'microsoftWindows', so: 'binaryData', dylib: 'binaryData',
  a: 'binaryData', o: 'binaryData', pyc: 'binaryData',
  zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive',
  rar: 'archive', '7z': 'archive',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', eot: 'font',
  txt: 'text', text: 'text', log: 'text',
  // No dedicated ExpUI lock or Kotlin file type exists in this pinned pack.
  lock: 'unknown', lockb: 'unknown', sum: 'unknown', kt: 'unknown', kts: 'unknown',
}

const LOCK_BASENAMES = new Set([
  'BUN.LOCKB', 'CARGO.LOCK', 'COMPOSER.LOCK', 'GEMFILE.LOCK', 'NPM-SHRINKWRAP.JSON',
  'PACKAGE-LOCK.JSON', 'PIPFILE.LOCK', 'PNPM-LOCK.YAML', 'POETRY.LOCK', 'YARN.LOCK',
])
