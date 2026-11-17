import { useEffect, useMemo, useState } from 'react'
import type { ImageMetadata } from '../../shared/library'

function valueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'null'
}

function RawData({ title, value }: { title: string; value: string }) {
  const [open, setOpen] = useState(false)
  return <details className="raw-data" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{title}</summary>{open && <pre>{value}</pre>}
  </details>
}

export function MetadataPanel({ imageId }: { imageId: string }) {
  const [metadata, setMetadata] = useState<ImageMetadata | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [type, setType] = useState('')
  const [limit, setLimit] = useState(50)
  useEffect(() => {
    let active = true
    setMetadata(null)
    setError('')
    window.library.getMetadata(imageId).then((result) => {
      if (active) setMetadata(result)
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : '无法读取原图元数据')
    })
    return () => { active = false }
  }, [imageId])
  const types = useMemo(() => [...new Set(metadata?.nodes.map((node) => node.type) ?? [])].sort(), [metadata])
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    return (metadata?.nodes ?? []).filter((node) => (!type || node.type === type) &&
      (!keyword || `${node.id} ${node.type} ${node.title} ${JSON.stringify(node.inputs)} ${JSON.stringify(node.widgets)}`.toLocaleLowerCase().includes(keyword)))
  }, [metadata, query, type])

  return <section className="metadata-panel" aria-label="ComfyUI 工作流元数据" aria-busy={!metadata && !error}>
    <h3>ComfyUI 工作流</h3>
    {error ? <p className="metadata-error" role="alert">{error}</p> : !metadata ? <p role="status">正在读取原图元数据…</p> : <>
      <p className={`metadata-status ${metadata.status}`}>{metadata.message}</p>
      {metadata.width && <p>原图尺寸：{metadata.width} × {metadata.height}</p>}
      {metadata.warnings.length > 0 && <details className="metadata-warning"><summary>{metadata.warnings.length} 项解析提示</summary>{metadata.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      {metadata.status === 'ok' && <>
        <div className="metadata-stats"><span>{metadata.nodes.length} 个节点</span><span>{types.length} 种类型</span><span>版本 {String(metadata.workflow?.version ?? '未知')}</span></div>
        <p className="metadata-legend">prompt：执行图 · workflow：编辑器图<br />包含两者的节点合并展示；widgets 保留原始顺序。</p>
        <input className="node-search" aria-label="搜索工作流节点" placeholder="搜索节点、标题或参数文本…" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(50) }} />
        <select className="node-type" aria-label="筛选节点类型" value={type} onChange={(event) => { setType(event.target.value); setLimit(50) }}><option value="">全部节点类型</option>{types.map((name) => <option key={name}>{name}</option>)}</select>
        <div className="node-results">显示 {Math.min(limit, filtered.length)} / {filtered.length} 个节点</div>
        {filtered.slice(0, limit).map((node) => <details className="workflow-node" key={node.id}>
          <summary><span className="node-id">#{node.id} · {node.source}</span><strong>{node.type}</strong>{node.title && <span className="node-title">{node.title}</span>}</summary>
          <dl>{Object.entries(node.inputs).map(([key, value]) => <div className="node-parameter" key={key}><dt>{key}</dt><dd><pre>{valueText(value)}</pre></dd></div>)}</dl>
          {node.widgets !== undefined && <div className="node-widgets"><span>widgets_values（原始控件值）</span><pre>{valueText(node.widgets)}</pre></div>}
          {Object.keys(node.inputs).length === 0 && node.widgets === undefined && <p>此节点没有可展示的参数。</p>}
        </details>)}
        {filtered.length === 0 && <p>没有匹配的节点。</p>}
        {limit < filtered.length && <button className="secondary full" onClick={() => setLimit((value) => value + 50)}>加载更多节点</button>}
      </>}
      {metadata.raw.prompt !== undefined && <RawData title="原始 prompt JSON" value={metadata.raw.prompt} />}
      {metadata.raw.workflow !== undefined && <RawData title="原始 workflow JSON" value={metadata.raw.workflow} />}
    </>}
  </section>
}
