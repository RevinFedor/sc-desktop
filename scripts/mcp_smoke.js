// MCP smoke test: spawn ./mcp/run.sh, list tools, call each.
// Runs under regular Node — the SDK is plain JS, doesn't touch better-sqlite3.
const { spawn } = require('node:child_process')
const path = require('node:path')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

async function main() {
  const projectRoot = path.resolve(__dirname, '..')
  const transport = new StdioClientTransport({
    command: path.join(projectRoot, 'mcp', 'run.sh'),
    args: [],
  })
  const client = new Client({ name: 'smoke', version: '0.0.1' }, { capabilities: {} })
  await client.connect(transport)

  const list = await client.listTools()
  console.log('TOOLS:', list.tools.map(t => t.name).join(', '))

  const chats = await client.callTool({ name: 'list_telegram_chats', arguments: {} })
  console.log('\nlist_telegram_chats →')
  console.log(chats.content[0].text.slice(0, 800))

  const search = await client.callTool({
    name: 'telegram_semantic_search',
    arguments: {
      source_id: 48,
      query: 'парсинг телеграма с поиском по векторам',
      limit: 5,
      min_cos: 0.55,
    },
  })
  console.log('\ntelegram_semantic_search →')
  console.log(search.content[0].text.slice(0, 1500))

  const parsed = JSON.parse(search.content[0].text)
  if (parsed.results && parsed.results.length) {
    const first = parsed.results[0].item_id
    const ngh = await client.callTool({
      name: 'telegram_neighbors',
      arguments: { item_id: first, before: 2, after: 2 },
    })
    console.log('\ntelegram_neighbors(' + first + ') →')
    console.log(ngh.content[0].text.slice(0, 1200))
  }

  await client.close()
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
