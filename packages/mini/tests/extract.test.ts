import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Mini } from '../src/index.js'
import { extractRows } from '../src/extract.js'

const enabled = Boolean(process.env.CALLISTO_SMOKE)

function fixtureServer() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/grid') {
      res.writeHead(404).end()
      return
    }
    const page = Number(url.searchParams.get('page') ?? '1')
    const rows = Array.from({ length: 3 }, (_, index) => {
      const id = (page - 1) * 3 + index + 1
      return `<tr><td>${id}</td><td><a href="/customer/${id}">customer${id}@example.com</a></td><td>$${(id * 10).toFixed(2)}</td></tr>`
    }).join('')
    const next = page < 3 ? `<a class="next" href="/grid?page=${page + 1}">Next</a>` : '<span class="next disabled">Next</span>'
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<title>Grid page ${page}</title><h1>Orders</h1>
      <table id="grid"><tbody>${rows}</tbody></table>
      <nav>${next}</nav>`)
  })
}

test('extract: reads typed rows and follows a pager', { skip: !enabled }, async () => {
  const server = fixtureServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const mini = await Mini.launch({ headless: true })
  try {
    const port = (server.address() as { port: number }).port
    await mini.goto(`http://127.0.0.1:${port}/grid?page=1`)

    const one = await extractRows(mini, {
      selector: '#grid tbody tr',
      fields: {
        id: { selector: 'td:nth-child(1)', type: 'number' },
        email: { selector: 'a', type: 'text' },
        href: { selector: 'a', attribute: 'href' },
        amount: { selector: 'td:nth-child(3)', type: 'number' },
      },
    })
    assert.equal(one.count, 3)
    assert.equal(one.pages, 1)
    assert.deepEqual(one.rows[0], { id: 1, email: 'customer1@example.com', href: '/customer/1', amount: 10 })

    const all = await extractRows(mini, {
      selector: '#grid tbody tr',
      fields: { id: { selector: 'td:nth-child(1)', type: 'number' } },
      paginate: { next: 'a.next', max_pages: 5 },
    })
    assert.equal(all.pages, 3)
    assert.equal(all.count, 9)
    assert.deepEqual(all.rows.map(row => row.id), [1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert.equal(new URL(all.url).searchParams.get('page'), '3')
  } finally {
    await mini.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('extract: row limit and text snapshot stay bounded', { skip: !enabled }, async () => {
  const server = fixtureServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const mini = await Mini.launch({ headless: true })
  try {
    const port = (server.address() as { port: number }).port
    await mini.goto(`http://127.0.0.1:${port}/grid?page=1`)
    const result = await extractRows(mini, {
      selector: '#grid tbody tr',
      fields: { id: { selector: 'td:nth-child(1)', type: 'number' } },
      limit: 2,
      include_text: true,
      paginate: { next: 'a.next', max_pages: 5 },
    })
    assert.equal(result.count, 6, 'each page contributes at most `limit` rows')
    assert.equal(result.truncated, true, 'omitted rows on each page must be reported')
    assert.ok(String(result.rows[0]._text).startsWith('1 customer1@example.com'))
  } finally {
    await mini.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('extract: waits for delayed pagination and fails when rows do not advance', { skip: !enabled }, async () => {
  const mini = await Mini.launch({headless:true})
  const html = `<div class="row">Page A</div><button id="next" onclick="setTimeout(()=>{document.querySelector('.row').textContent='Page B';this.disabled=true},700)">Next</button>`
  try {
    await mini.goto('data:text/html,' + encodeURIComponent(html))
    const spec = {selector:'.row', fields:{value:{}}, paginate:{next:'#next',max_pages:2}}
    const result = await extractRows(mini, spec)
    assert.deepEqual(result.rows, [{value:'Page A'}, {value:'Page B'}])
    assert.equal(result.truncated,false)
    await mini.goto('data:text/html,' + encodeURIComponent('<div class="row">Same</div><button id="next">Next</button>'))
    await assert.rejects(extractRows(mini, spec), /did not produce a stable, different set of rows/)
    await mini.goto('data:text/html,' + encodeURIComponent(html))
    const limited = await extractRows(mini, {...spec, paginate:{next:'#next',max_pages:1}})
    assert.equal(limited.truncated,true)
  } finally { await mini.close() }
})

test('extract: pager clicks enforce actionability and connected execution', { skip: !enabled }, async () => {
  const mini = await Mini.launch({headless:true})
  const session = (mini as unknown as {session:{mode?:string; connectedExecute?:()=>Promise<unknown>}}).session
  try {
    await mini.goto('data:text/html,'+encodeURIComponent('<div class="row">A</div><button id="next" style="display:none" onclick="document.body.dataset.clicked=1">Next</button>'))
    const spec = {selector:'.row',fields:{value:{}},paginate:{next:'#next',max_pages:2}}
    await assert.rejects(extractRows(mini,spec), /not actionable/)
    assert.equal(await mini.evaluate(()=>document.body.dataset.clicked), undefined)
    await mini.goto('data:text/html,'+encodeURIComponent('<div class="row">A</div><button id="next" onclick="document.body.dataset.clicked=1">Next</button>'))
    let executions=0
    session.mode='connected'
    session.connectedExecute=async()=>{executions++;throw new Error('Tab taken back')}
    await assert.rejects(extractRows(mini,spec), /Tab taken back/)
    assert.equal(executions,1)
    assert.equal(await mini.evaluate(()=>document.body.dataset.clicked), undefined)
  } finally {
    session.mode=undefined
    await mini.close()
  }
})
