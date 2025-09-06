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

  const [selectedIndex, setSelectedIndex] = useState(0)
  const selected = photos[selectedIndex]

  const handleArrowNavigation = useCallback(
    (event) => {
      if (event.key === 'ArrowRight') {
        setSelectedIndex((currentIndex) =>
          Math.min(currentIndex + 1, photos.length - 1)
        )
      } else if (event.key === 'ArrowLeft') {
        setSelectedIndex((currentIndex) => Math.max(currentIndex - 1, 0))
      }
    },
    [photos.length]
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
      <aside className="sidebar">
        <div className="thumb-grid">
          {photos.map((p, idx) => (
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
