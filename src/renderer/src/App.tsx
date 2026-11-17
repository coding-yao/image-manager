import { useEffect, useMemo, useState } from 'react'
import type { ImageEntry, LibrarySnapshot } from '../../shared/library'
import { MetadataPanel } from './MetadataPanel'

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`
}

function Thumbnail({ image, selected, onSelect }: { image: ImageEntry; selected: boolean; onSelect: () => void }) {
  const [failed, setFailed] = useState(false)
  return <button className={`image-card ${selected ? 'selected' : ''}`} onClick={onSelect} aria-label={`查看 ${image.relativePath}`}>
    <div className="thumbnail">
      {failed ? <span className="image-error">无法生成缩略图<br /><small>点击尝试预览原图</small></span>
        : <img src={image.thumbnailUrl} alt={image.name} loading="lazy" decoding="async" onError={() => setFailed(true)} />}
      <span className="extension">{image.name.split('.').pop()?.toUpperCase()}</span>
    </div>
    <div className="card-caption"><strong title={image.relativePath}>{image.name}</strong><span>{formatSize(image.size)}</span></div>
  </button>
}

export function App() {
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null)
  const [recursive, setRecursive] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('newest')
  const [selected, setSelected] = useState<ImageEntry | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [visibleCount, setVisibleCount] = useState(120)

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [])
  useEffect(() => { setPreviewFailed(false) }, [selected?.id])
  useEffect(() => { setVisibleCount(120) }, [library, query, sort])

  async function load(mode: 'choose' | 'refresh', nextRecursive = recursive) {
    setBusy(true)
    setError('')
    if (mode === 'refresh') setRecursive(nextRecursive)
    try {
      const result = await (mode === 'choose' ? window.library.chooseDirectory(nextRecursive) : window.library.refresh(nextRecursive))
      if (result) {
        setLibrary(result)
        setRecursive(result.recursive)
        setSelected(null)
      }
    } catch (cause) {
      setRecursive(library?.recursive ?? recursive)
      setError(cause instanceof Error ? cause.message : '读取失败，请检查目录是否存在及访问权限。')
    } finally {
      setBusy(false)
    }
  }

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    const images = (library?.images ?? []).filter((image) => image.relativePath.toLocaleLowerCase().includes(keyword))
    return images.sort((a, b) => sort === 'name' ? a.relativePath.localeCompare(b.relativePath, 'zh-CN', { numeric: true })
      : sort === 'oldest' ? a.modifiedAt - b.modifiedAt : b.modifiedAt - a.modifiedAt)
  }, [library, query, sort])

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-symbol">C</span><div>Comfy<span>IMAGE MANAGER</span></div></div>
      <div className="sidebar-label">工作空间</div>
      <div className="nav-item active"><span>▦</span> 图片库 <span className="count">{library?.images.length ?? 0}</span></div>
      <div className="sidebar-label folder-heading">当前目录</div>
      <div className="directory-box"><span className="folder-icon">▱</span><p title={library?.root}>{library?.root ?? '尚未选择目录'}</p></div>
      <button className="secondary full" disabled={busy} onClick={() => void load('choose')}>选择图片目录</button>
      <label className="checkbox"><input type="checkbox" checked={recursive} disabled={busy} onChange={(event) => {
        const value = event.target.checked
        if (library) void load('refresh', value)
        else setRecursive(value)
      }} /> 包含子目录</label>
      <div className="sidebar-bottom"><span className="status-dot" /> 本地图片库<p>图片保留在原始目录中</p><span className="version">FRAMEWORK · v0.1.0</span></div>
    </aside>
    <main>
      <header className="page-header"><div><div className="eyebrow">YOUR CREATIVE ARCHIVE</div><h1>图片库<span>Library</span></h1><p>收集每一次灵感，回看每一帧创作。</p></div>
        <button className="primary" disabled={busy} onClick={() => void load('choose')}><span>＋</span> 选择目录</button>
      </header>
      <section className="toolbar" aria-label="图片筛选">
        <div className="search"><span>⌕</span><input aria-label="按文件名或路径筛选" placeholder="按文件名或路径筛选…" value={query} onChange={(event) => setQuery(event.target.value)} disabled={!library} /></div>
        <select aria-label="排序方式" value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">最近修改优先</option><option value="oldest">最早修改优先</option><option value="name">文件名称 A–Z</option></select>
        <button className="secondary refresh" disabled={busy || !library} onClick={() => void load('refresh')}>↻ 刷新</button>
      </section>
      {error && <div className="message error" role="alert">{error}</div>}
      {!!library?.warnings.length && <details className="message"><summary>{library.warnings.length} 个项目无法读取，已跳过</summary>{library.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</details>}
      <div className="library-heading"><span>{library ? `${filtered.length} 张图片` : '你的创作，从这里开始'}</span><span>{busy ? '正在读取目录…' : library ? (recursive ? '包含所有子目录' : '仅当前目录') : 'PNG · JPG · WEBP · GIF · BMP · AVIF'}</span></div>
      <section className="gallery-area" aria-busy={busy}>
        {!library ? <div className="empty-state"><div className="empty-art"><span>▧</span><i>＋</i></div><h2>为你的灵感，留一个位置</h2><p>选择 ComfyUI 的输出目录，开始浏览你的图片。<br />也可以选择任意本地图片文件夹。</p><button className="primary" disabled={busy} onClick={() => void load('choose')}>{busy ? '正在读取…' : '选择图片目录'}</button><small>直接浏览本地文件，无需导入或复制</small></div>
          : filtered.length === 0 ? <div className="empty-state"><div className="empty-icon">▧</div><h2>{query ? '没有匹配的图片' : '这个目录中还没有图片'}</h2><p>{query ? '试试其他文件名或清空筛选条件。' : '可开启「包含子目录」，或选择其他文件夹。'}</p>{query && <button className="secondary" onClick={() => setQuery('')}>清空筛选</button>}</div>
          : <><div className="image-grid">{filtered.slice(0, visibleCount).map((image) => <Thumbnail key={image.id} image={image} selected={selected?.id === image.id} onSelect={() => setSelected(image)} />)}</div>{visibleCount < filtered.length && <button className="secondary load-more" onClick={() => setVisibleCount((count) => count + 120)}>加载更多（已显示 {visibleCount} / {filtered.length}）</button>}</>}
      </section>
      <footer><span>COMFY IMAGE MANAGER</span><span>本地浏览 · 灵感有迹可循</span></footer>
    </main>
    {selected && <div className="preview-overlay" onClick={() => setSelected(null)}><section role="dialog" aria-modal="true" aria-label="图片预览" className="preview-dialog" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      if (event.key === 'Tab') {
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, summary')]
          .filter((element) => element.getClientRects().length > 0)
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <button autoFocus className="close-preview secondary" aria-label="关闭预览" onClick={() => setSelected(null)}>✕</button>
      <div className="preview-image">{previewFailed ? <p>无法预览此图片，文件可能已移动或格式不受支持。</p> : <img src={selected.previewUrl} alt={selected.name} onError={() => setPreviewFailed(true)} />}</div>
      <aside className="image-details"><div className="eyebrow">IMAGE DETAILS</div><h2>{selected.name}</h2><dl><dt>相对路径</dt><dd>{selected.relativePath}</dd><dt>文件大小</dt><dd>{formatSize(selected.size)}</dd><dt>修改时间</dt><dd>{new Date(selected.modifiedAt).toLocaleString('zh-CN')}</dd></dl><MetadataPanel key={selected.id} imageId={selected.id} /></aside>
    </section></div>}
  </div>
}
