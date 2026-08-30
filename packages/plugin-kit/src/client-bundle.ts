/**
 * dsh 客户端插件打包：产出 `lib/client.js`，形状必须与上游
 * `packages/client/tsdown.client.ts` 的 banner/footer/intro 一致——
 * 浏览器里由 `window.__ModuleLoader__.load({ id, factory })` 接手，
 * factory 收到的 `require` 走 loader 模块表，不是 Node require。
 *
 * 本文件是精简镜像：只保留工厂包装 + 平台 external。不抄 workspace glob、
 * Host/Client face、purity gate 全文；bump submodule 时对照上游
 * `clientConfig()` 的 outputOptions 与 PLATFORM_MODULES。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { build } from 'esbuild'

/**
 * 壳种进模块表的平台模块（上游 `packages/client/web/src/platform.ts`）。
 * 必须 external，否则会打进包里变成第二份 React/cordis。
 */
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

/** 预加载的 runtime client 半（同上游 PRELOADED_CLIENT_EXTERNALS）。 */
export const PRELOADED_CLIENT_EXTERNALS = ['@deepseek-ai/dsh-client-runtime/client'] as const

export interface BuildClientBundleOptions {
  /** 插件包名，写入 ModuleLoader id，必须与 package.json name 一致。 */
  id: string
  /** 客户端入口（通常 src/client/index.ts）。 */
  entry: string
  /** 输出路径（通常 lib/client.js）。 */
  outfile: string
  /** 包声明的 dsh.client.external，叠在平台基线之上。 */
  extraExternals?: readonly string[]
}

function styleInjection(id: string, css: string): string {
  if (css.trim().length === 0) return ''
  const tagId = `${id}/client.css`
  return [
    `var __dshCss = ${JSON.stringify(css)};`,
    `var __dshCssId = ${JSON.stringify(tagId)};`,
    "var __dshStyle = document.querySelector('style[data-plugin-css=' + JSON.stringify(__dshCssId) + ']');",
    'if (__dshStyle === null) {',
    "  __dshStyle = document.createElement('style');",
    `  __dshStyle.dataset.plugin = ${JSON.stringify(id)};`,
    '  __dshStyle.dataset.pluginCss = __dshCssId;',
    '  document.head.appendChild(__dshStyle);',
    '}',
    'if (__dshStyle.textContent !== __dshCss) __dshStyle.textContent = __dshCss;',
  ].join('\n')
}

/** 把 esbuild CJS 包进 ModuleLoader 工厂（与上游 intro + banner + footer 同构）。 */
export function wrapClientFactory(id: string, code: string, css = ''): string {
  return [
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    'var module = { exports: {} }; var exports = module.exports;',
    styleInjection(id, css),
    code.replace(/\/\/# sourceMappingURL=.*$/m, '').trimEnd(),
    'return module.exports; } });',
    '',
  ].join('\n')
}

export async function buildClientBundle(options: BuildClientBundleOptions): Promise<void> {
  const external = [
    ...PLATFORM_MODULES,
    ...PRELOADED_CLIENT_EXTERNALS,
    ...(options.extraExternals ?? []),
  ]
  const result = await build({
    absWorkingDir: process.cwd(),
    bundle: true,
    entryPoints: [options.entry],
    outdir: 'dsh-client-output',
    entryNames: 'client',
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    sourcemap: 'inline',
    logLevel: 'info',
    loader: { '.css': 'css' },
    plugins: [{
      name: 'dsh-css-modules',
      setup(buildContext) {
        buildContext.onLoad({ filter: /\.module\.css$/ }, async (loadArgs) => ({
          contents: await readFile(loadArgs.path, 'utf8'),
          loader: 'local-css',
          resolveDir: dirname(loadArgs.path),
        }))
      },
    }],
    external: [...external],
  })
  const js = result.outputFiles.find((file) => file.path.endsWith('.js'))
  if (js === undefined) throw new Error(`client bundle produced no JavaScript for ${options.id}`)
  const css = result.outputFiles
    .filter((file) => file.path.endsWith('.css'))
    .map((file) => file.text.replace(/\/\*# sourceMappingURL=.*?\*\//gsu, ''))
    .join('\n')
  await mkdir(dirname(options.outfile), { recursive: true })
  await writeFile(options.outfile, wrapClientFactory(options.id, js.text, css), 'utf8')
}
