import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

function App() {
  const photos = useMemo(
    () => [
      { id: 10, url: 'https://picsum.photos/id/10/800/600', title: 'Forest Walk', date: '2024-08-12', size: '800x600' },
      { id: 20, url: 'https://picsum.photos/id/20/800/600', title: 'Calm Lake', date: '2024-07-02', size: '800x600' },
      { id: 30, url: 'https://picsum.photos/id/30/800/600', title: 'City Lines', date: '2024-05-19', size: '800x600' },
      { id: 40, url: 'https://picsum.photos/id/40/800/600', title: 'Golden Field', date: '2024-04-03', size: '800x600' },
      { id: 50, url: 'https://picsum.photos/id/50/800/600', title: 'Mountain View', date: '2024-03-15', size: '800x600' },
      { id: 60, url: 'https://picsum.photos/id/60/800/600', title: 'Urban Alley', date: '2024-02-28', size: '800x600' },
      { id: 70, url: 'https://picsum.photos/id/70/800/600', title: 'Quiet Shore', date: '2024-01-11', size: '800x600' },
      { id: 80, url: 'https://picsum.photos/id/80/800/600', title: 'Blue Horizon', date: '2023-12-01', size: '800x600' },
      { id: 90, url: 'https://picsum.photos/id/90/800/600', title: 'Stone Path', date: '2023-11-17', size: '800x600' },
      { id: 100, url: 'https://picsum.photos/id/100/800/600', title: 'Misty Morning', date: '2023-10-05', size: '800x600' },
      { id: 110, url: 'https://picsum.photos/id/110/800/600', title: 'Riverside', date: '2023-09-23', size: '800x600' },
      { id: 120, url: 'https://picsum.photos/id/120/800/600', title: 'Desert Road', date: '2023-08-08', size: '800x600' },
    ],
    []
  )

  // Tags state per photo id (must be declared before usage)
  const [tagsById, setTagsById] = useState({})
  const [tagInput, setTagInput] = useState('')

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
  const allTags = useMemo(() => {
    const unique = new Set()
    Object.values(tagsById).forEach((arr) => {
      ;(arr || []).forEach((t) => unique.add(t))
    })
    return Array.from(unique)
  }, [tagsById])

  const suggestions = useMemo(() => {
    const q = tagInput.trim().toLowerCase()
    if (!q) return []
    return allTags
      .filter((t) => t.toLowerCase().includes(q))
      .filter((t) => !selectedTags.map((s) => s.toLowerCase()).includes(t.toLowerCase()))
      .slice(0, 8)
  }, [allTags, selectedTags, tagInput])

  const addTag = useCallback(
    (newTag) => {
      const tag = newTag.trim()
      if (!selected?.id || !tag) return
      const exists = (tagsById[selected.id] || []).some((t) => t.toLowerCase() === tag.toLowerCase())
      if (exists) return
      setTagsById((prev) => ({ ...prev, [selected.id]: [ ...(prev[selected.id] || []), tag ] }))
      setTagInput('')
    },
    [selected, tagsById]
  )

  const removeTag = useCallback(
    (tagToRemove) => {
      if (!selected?.id) return
      setTagsById((prev) => ({
        ...prev,
        [selected.id]: (prev[selected.id] || []).filter((t) => t !== tagToRemove),
      }))
    },
    [selected]
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

  return (
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
              <img className="thumb-img" src={p.url} alt={p.title} loading="lazy" />
            </button>
          ))}
        </div>
      </aside>

      <main className="preview-pane">
        <div className="preview-area">
          {selected && (
            <img className="preview-img" src={selected.url} alt={selected.title} />
          )}
        </div>
        <section className="details">
          {selected ? (
            <div className="details-grid">
              <div className="detail"><span className="label">Title</span><span className="value">{selected.title}</span></div>
              <div className="detail"><span className="label">Date</span><span className="value">{selected.date}</span></div>
              <div className="detail"><span className="label">Dimensions</span><span className="value">{selected.size}</span></div>
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
  )
}

export default App
