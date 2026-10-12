const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

// Actual component rendering, with only external registries replaced by small
// fixtures. No Electron, Telegram, browser settings or user storage is opened.
async function loadComponent(file, mockRegistries = false) {
  const mocks = {
    '../lib/jobs': 'export const useJobsSelector=()=>[]; export const cancelJob=async()=>true;',
    '../lib/store': 'export function pushScreen(){}; export function closeActivity(){};',
    '../lib/sources': 'export const useSources=()=>[{id:2,platform:"telegram",display_name:"fixture long chat",handle:"fixture"}];',
    '../lib/folders': 'export const useFolders=()=>[];',
  }
  const filename = path.join(__dirname, '..', file)
  const built = await esbuild.build({
    entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['react', 'react-dom', 'lucide-react'],
    plugins: mockRegistries ? [{
      name: 'registry-fixtures',
      setup(build) {
        build.onResolve({ filter: /^\.\.\/lib\/(jobs|store|sources|folders)$/ }, args => (
          args.importer.endsWith('ActivityPanel.jsx') ? { path: args.path, namespace: 'fixture' } : null
        ))
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }))
      },
    }] : [],
  })
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(built.outputFiles[0].text, filename)
  return loaded.exports
}

test('IndexButton distinguishes preparation from zero-message indexing', async () => {
  const { default: IndexButton } = await loadComponent('src/components/IndexButton.jsx')
  const html = renderToStaticMarkup(React.createElement(IndexButton, {
    status: { state: 'running', phase: 'starting', done: 0, total: 0 },
  }))
  assert.match(html, /Подготавливаю индекс…/u)
  assert.doesNotMatch(html, /Индексирую… 0/u)
  assert.match(html, /disabled=""/u)
})

test('preparing request identifies its chat and retains the existing Cancel control', async () => {
  const { RequestJobRow } = await loadComponent('src/components/ActivityPanel.jsx', true)
  const html = renderToStaticMarkup(React.createElement(RequestJobRow, {
    active: true,
    job: { id: 'index-2', type: 'tg_index', source_id: 2, phase: 'starting', status: 'running',
      items_done: 0, items_total: 0, target: null },
  }))
  assert.match(html, /Telegram · индексация/u)
  assert.match(html, /fixture long chat/u)
  assert.match(html, /Подготавливаю индекс…/u)
  assert.match(html, /data-cancel-job/u)
  assert.match(html, /Отмена/u)
})

test('long-message work reports fragments while publication remains zero messages', async () => {
  const { RequestJobRow } = await loadComponent('src/components/ActivityPanel.jsx', true)
  const html = renderToStaticMarkup(React.createElement(RequestJobRow, {
    active: true,
    job: { id: 'index-2', type: 'tg_index', source_id: 2, phase: 'running', status: 'running',
      items_done: 0, items_total: 1, unit: 'messages', messages_selected: 1,
      fragments_total: 194, fragments_embedded: 100 },
  }))
  assert.match(html, /data-index-fragments-progress/u)
  assert.match(html, /Фрагменты: /u)
  assert.match(html, /100/u)
  assert.match(html, /194/u)
  assert.doesNotMatch(html, /Подготавливаю индекс…/u)
})
