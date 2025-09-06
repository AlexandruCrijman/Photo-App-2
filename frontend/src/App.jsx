import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

function App() {
  const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000'
  const [photos, setPhotos] = useState([])

  // Tags state per photo id (must be declared before usage)
  const [tagsById, setTagsById] = useState({})
  const [tagInput, setTagInput] = useState('')
  const [allTags, setAllTags] = useState([])

  const [activeTag, setActiveTag] = useState(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  const filteredPhotos = useMemo(() => {
    if (!activeTag) return photos
    return photos.filter((p) => (tagsById[p.id] || []).some((t) => t.toLowerCase() === activeTag.toLowerCase()))
  }, [activeTag, photos, tagsById])

  useEffect(() => {
    if (selectedIndex >= filteredPhotos.length) {
      setSelectedIndex(0)
    }
  }, [filteredPhotos.length, selectedIndex])

  const selected = filteredPhotos[selectedIndex]

  const selectedTags = useMemo(() => tagsById[selected?.id] || [], [tagsById, selected])

  const suggestions = useMemo(() => {
    const q = tagInput.trim().toLowerCase()
    if (!q) return []
    return allTags
      .filter((t) => t.toLowerCase().includes(q))
      .filter((t) => !selectedTags.map((s) => s.toLowerCase()).includes(t.toLowerCase()))
      .slice(0, 8)
  }, [allTags, selectedTags, tagInput])

  const addTag = useCallback(
    async (newTag) => {
      const tag = newTag.trim()
      if (!selected?.id || !tag) return
      try {
        const resp = await fetch(`${API_BASE}/photos/${selected.id}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tag })
        })
        if (!resp.ok) throw new Error('Failed to add tag')
        const updated = await resp.json()
        setTagsById((prev) => ({ ...prev, [updated.id]: updated.tags || [] }))
        setPhotos((prev) => prev.map((p) => (p.id === updated.id ? { ...p } : p)))
        setAllTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]))
      } catch (e) {
        console.error(e)
      } finally {
        setTagInput('')
      }
    },
    [API_BASE, selected]
  )

  const removeTag = useCallback(
    async (tagToRemove) => {
      if (!selected?.id) return
      try {
        const resp = await fetch(`${API_BASE}/photos/${selected.id}/tags`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tag: tagToRemove })
        })
        if (!resp.ok) throw new Error('Failed to remove tag')
        const updated = await resp.json()
        setTagsById((prev) => ({ ...prev, [updated.id]: updated.tags || [] }))
        setPhotos((prev) => prev.map((p) => (p.id === updated.id ? { ...p } : p)))
      } catch (e) {
        console.error(e)
      }
    },
    [API_BASE, selected]
  )

  const onTagInputKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault()
        if (tagInput.trim()) addTag(tagInput)
      } else if (e.key === 'Backspace' && !tagInput) {
        const last = selectedTags[selectedTags.length - 1]
        if (last) removeTag(last)
      }
    },
    [addTag, removeTag, selectedTags, tagInput]
  )

  const handleArrowNavigation = useCallback(
    (event) => {
      if (event.key === 'ArrowRight') {
        setSelectedIndex((currentIndex) =>
          Math.min(currentIndex + 1, filteredPhotos.length - 1)
        )
      } else if (event.key === 'ArrowLeft') {
        setSelectedIndex((currentIndex) => Math.max(currentIndex - 1, 0))
      }
    },
    [filteredPhotos.length]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleArrowNavigation)
    return () => window.removeEventListener('keydown', handleArrowNavigation)
  }, [handleArrowNavigation])

  useEffect(() => {
    const selectedElement = document.querySelector('.thumb-btn.selected')
    if (selectedElement && 'scrollIntoView' in selectedElement) {
      selectedElement.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [selectedIndex])

  // Initial load: fetch photos and tags
  useEffect(() => {
    async function load() {
      try {
        const [photosResp, tagsResp] = await Promise.all([
          fetch(`${API_BASE}/photos`),
          fetch(`${API_BASE}/tags`)
        ])
        const photosJson = photosResp.ok ? await photosResp.json() : []
        const tagsJson = tagsResp.ok ? await tagsResp.json() : []
        setPhotos(Array.isArray(photosJson) ? photosJson : [])
        const initialMap = {}
        for (const p of photosJson || []) {
          initialMap[p.id] = Array.isArray(p.tags) ? p.tags : []
        }
        setTagsById(initialMap)
        setAllTags((tagsJson || []).map((t) => t.name))
      } catch (e) {
        console.error('Failed to load data', e)
      }
    }
    load()
  }, [API_BASE])

  return (
    <>
      <header className="topbar">
        <div className="brand">Photo Classification App</div>
      </header>
      <div className="app-container">
      <nav className="tag-rail">
        <div className="tag-rail-header">Tags</div>
        <button
          className={`tag-rail-item ${!activeTag ? 'active' : ''}`}
          onClick={() => setActiveTag(null)}
        >
          All
        </button>
        {allTags.map((t) => (
          <button
            key={t}
            className={`tag-rail-item ${activeTag && activeTag.toLowerCase() === t.toLowerCase() ? 'active' : ''}`}
            onClick={() => {
              setActiveTag((curr) => (curr && curr.toLowerCase() === t.toLowerCase() ? null : t))
              setSelectedIndex(0)
            }}
            title={t}
          >
            {t}
          </button>
        ))}
      </nav>
      <aside className="sidebar">
        <div className="thumb-grid">
          {filteredPhotos.map((p, idx) => (
            <button
              key={p.id}
              className={`thumb-btn ${idx === selectedIndex ? 'selected' : ''}`}
              onClick={() => setSelectedIndex(idx)}
              title={p.title}
            >
              <img
                className="thumb-img"
                src={p.url || `${API_BASE}/uploads/${p.filename}`}
                alt={p.title || p.original_name || `Photo ${p.id}`}
                loading="lazy"
              />
            </button>
          ))}
        </div>
      </aside>

      <main className="preview-pane">
        <div className="preview-area">
          {selected && (
            <img
              className="preview-img"
              src={selected.url || `${API_BASE}/uploads/${selected.filename}`}
              alt={selected.title || selected.original_name || `Photo ${selected.id}`}
            />
          )}
        </div>
        <section className="details">
          {selected ? (
            <div className="details-grid">
              {selected.title && (
                <div className="detail"><span className="label">Title</span><span className="value">{selected.title}</span></div>
              )}
              {selected.date && (
                <div className="detail"><span className="label">Date</span><span className="value">{selected.date}</span></div>
              )}
              {selected.size && (
                <div className="detail"><span className="label">Dimensions</span><span className="value">{selected.size}</span></div>
              )}
              <div className="detail"><span className="label">ID</span><span className="value">{selected.id}</span></div>
              <div className="detail tags-row">
                <span className="label">Persons</span>
                <div className="value">
                  <div className="tags-input" onClick={() => document.getElementById('tag-input')?.focus()}>
                    {selectedTags.map((t) => (
                      <span key={t} className="tag-chip">
                        {t}
                        <button className="tag-remove" onClick={() => removeTag(t)} aria-label={`Remove ${t}`}>×</button>
                      </span>
                    ))}
                    <input
                      id="tag-input"
                      className="tag-text"
                      type="text"
                      placeholder="Add person..."
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={onTagInputKeyDown}
                    />
                  </div>
                  {suggestions.length > 0 && (
                    <ul className="suggestions">
                      {suggestions.map((s) => (
                        <li key={s}>
                          <button type="button" className="suggestion-btn" onClick={() => addTag(s)}>{s}</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="details-empty">Select a photo to see details</div>
          )}
        </section>
      </main>
    </div>
    </>
  )
}

export default App
