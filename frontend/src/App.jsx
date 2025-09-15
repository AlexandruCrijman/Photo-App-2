import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

function App() {
  const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000'
  const [photos, setPhotos] = useState([])
  const [nextCursor, setNextCursor] = useState(null)
  const [isLoadingPage, setIsLoadingPage] = useState(false)

  // Tags state per photo id (must be declared before usage)
  const [tagsById, setTagsById] = useState({})
  const [tagInput, setTagInput] = useState('')
  const [allTags, setAllTags] = useState([])
  const [renamingTag, setRenamingTag] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [tagMenu, setTagMenu] = useState({ open: false, x: 0, y: 0, tag: null })
  const [confirmDeleteTag, setConfirmDeleteTag] = useState(null) // string | string[]

  const [activeTags, setActiveTags] = useState([])
  const [tagAnchorIndex, setTagAnchorIndex] = useState(null)
  const tagRailRef = useRef(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedIndices, setSelectedIndices] = useState(() => new Set())
  const [anchorIndex, setAnchorIndex] = useState(0)
  const gridRef = useRef(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isBulkUploading, setIsBulkUploading] = useState(false)
  const [bulkTotal, setBulkTotal] = useState(0)
  const [bulkDone, setBulkDone] = useState(0)
  // Virtualization removed for stability; keeping simple grid

  const [stats, setStats] = useState({ total: 0, completed: 0 })
  const [events, setEvents] = useState([])
  const [currentEventId, setCurrentEventId] = useState(null)
  const [currentEventName, setCurrentEventName] = useState('Default')
  const [showNewEvent, setShowNewEvent] = useState(false)
  const [newEventName, setNewEventName] = useState('')
  const [isCreatingEvent, setIsCreatingEvent] = useState(false)
  const [reopenSettingsOnEventCancel, setReopenSettingsOnEventCancel] = useState(false)
  const [showDeleteEvent, setShowDeleteEvent] = useState(false)
  const [isDeletingEvent, setIsDeletingEvent] = useState(false)
  const [reopenSettingsOnDeleteCancel, setReopenSettingsOnDeleteCancel] = useState(false)
  // Person view (share link) state
  const [isPersonView, setIsPersonView] = useState(false)
  const [shareToken, setShareToken] = useState('')
  const [showPersonLogin, setShowPersonLogin] = useState(false)
  const [personPassword, setPersonPassword] = useState('')
  const [personTagName, setPersonTagName] = useState('')
  const [personEventName, setPersonEventName] = useState('')
  const [isSubmittingLogin, setIsSubmittingLogin] = useState(false)
  const [personLoginError, setPersonLoginError] = useState('')
  const personLoginDoneRef = useRef(false)
  const shareInitRef = useRef(false)

  const [faces, setFaces] = useState([])
  const previewImgRef = useRef(null)
  const [previewSize, setPreviewSize] = useState({ w: 0, h: 0 })

  const filteredPhotos = useMemo(() => {
    if (!activeTags || activeTags.length === 0) return photos
    const selectedLower = new Set(activeTags.map((t) => t.toLowerCase()))
    return photos.filter((p) => (tagsById[p.id] || []).some((t) => selectedLower.has(String(t).toLowerCase())))
  }, [activeTags, photos, tagsById])

  const completedCount = useMemo(() => {
    return stats.completed ?? filteredPhotos.filter((p) => p.completed).length
  }, [filteredPhotos, stats])

  const refreshStats = useCallback(async () => {
    try {
      const qs = activeTags && activeTags.length > 0 ? `?tags=${encodeURIComponent(activeTags.join(','))}` : ''
      const resp = await fetch(`${API_BASE}/stats${qs}`, { credentials: 'include' })
      if (resp.ok) {
        const json = await resp.json()
        setStats({ total: json.total || 0, completed: json.completed || 0 })
      }
    } catch (e) { console.error(e) }
  }, [API_BASE, activeTags])

  useEffect(() => {
    if (selectedIndex >= filteredPhotos.length) {
      setSelectedIndex(0)
    }
    // Clamp multiselect to available items when filter changes
    setSelectedIndices((prev) => {
      const next = new Set()
      for (const idx of prev) {
        if (idx < filteredPhotos.length) next.add(idx)
      }
      return next
    })
  }, [filteredPhotos.length, selectedIndex])

  const selected = filteredPhotos[selectedIndex]

  const selectedTags = useMemo(() => tagsById[selected?.id] || [], [tagsById, selected])

  const [debouncedTagInput, setDebouncedTagInput] = useState('')
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(-1)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedTagInput(tagInput), 150)
    return () => clearTimeout(t)
  }, [tagInput])

  const suggestions = useMemo(() => {
    const q = debouncedTagInput.trim().toLowerCase()
    if (!q) return []
    return allTags
      .filter((t) => t.toLowerCase().includes(q))
      .filter((t) => !selectedTags.map((s) => s.toLowerCase()).includes(t.toLowerCase()))
      .slice(0, 8)
  }, [allTags, selectedTags, debouncedTagInput])

  useEffect(() => {
    if (suggestions.length > 0) setHighlightedSuggestion(0); else setHighlightedSuggestion(-1)
  }, [suggestions])

  const addTag = useCallback(
    async (newTag) => {
      const tag = newTag.trim()
      if (!selected?.id || !tag) return
      // normalize to existing casing if tag exists in global list
      const existing = allTags.find((t) => t.toLowerCase() === tag.toLowerCase())
      const normalizedTag = existing || tag
      const photoId = selected.id
      const prev = tagsById[photoId] || []
      // optimistic
      setTagsById((p) => ({
        ...p,
        [photoId]: prev.some((t) => t.toLowerCase() === normalizedTag.toLowerCase()) ? prev : [...prev, normalizedTag],
      }))
      setAllTags((prevAll) => (prevAll.some((t) => t.toLowerCase() === normalizedTag.toLowerCase()) ? prevAll : [...prevAll, normalizedTag]))
      setTagInput('')
      try {
        const resp = await fetch(`${API_BASE}/photos/${photoId}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tag: normalizedTag }),
          credentials: 'include',
        })
        if (!resp.ok) throw new Error('Failed to add tag')
        const updated = await resp.json()
        setTagsById((p) => ({ ...p, [updated.id]: updated.tags || [] }))
      } catch (e) {
        console.error(e)
        // rollback
        setTagsById((p) => ({ ...p, [photoId]: prev }))
      }
    },
    [API_BASE, selected, tagsById, allTags]
  )

  const removeTag = useCallback(
    async (tagToRemove) => {
      if (!selected?.id) return
      const photoId = selected.id
      const prev = tagsById[photoId] || []
      const canonical = (prev.find((t) => t.toLowerCase() === tagToRemove.toLowerCase())) || tagToRemove
      // optimistic
      setTagsById((p) => ({ ...p, [photoId]: prev.filter((t) => t.toLowerCase() !== canonical.toLowerCase()) }))
      try {
        const resp = await fetch(`${API_BASE}/photos/${photoId}/tags`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tag: canonical }),
          credentials: 'include',
        })
        if (!resp.ok) throw new Error('Failed to remove tag')
        const updated = await resp.json()
        setTagsById((p) => ({ ...p, [updated.id]: updated.tags || [] }))
      } catch (e) {
        console.error(e)
        // rollback
        setTagsById((p) => ({ ...p, [photoId]: prev }))
      }
    },
    [API_BASE, selected, tagsById]
  )

  const renameTag = useCallback(
    async (oldName, newNameRaw) => {
      const newName = (newNameRaw || '').trim()
      if (!oldName || !newName) { setRenamingTag(null); setRenameValue(''); return }
      const oldLower = String(oldName).toLowerCase()
      const newLower = newName.toLowerCase()
      if (oldLower === newLower) { setRenamingTag(null); setRenameValue(''); return }
      try {
        const resp = await fetch(`${API_BASE}/tags/${encodeURIComponent(oldName)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newName }),
          credentials: 'include'
        })
        if (!resp.ok) throw new Error('Rename failed')
        const json = await resp.json()
        const serverTags = (json && Array.isArray(json.tags)) ? json.tags.map((t) => t.name) : allTags
        setAllTags(serverTags)
        // determine final casing of target
        const finalName = serverTags.find((n) => n.toLowerCase() === newLower) || newName
        // update active filters
        setActiveTags((prev) => {
          const mapped = prev.map((n) => (n.toLowerCase() === oldLower ? finalName : n))
          // dedupe (case-insensitive)
          const out = []
          const seen = new Set()
          for (const n of mapped) {
            const key = n.toLowerCase()
            if (!seen.has(key)) { seen.add(key); out.push(n) }
          }
          return out
        })
        // update per-photo tags map
        setTagsById((prev) => {
          const next = { ...prev }
          for (const pid of Object.keys(next)) {
            const list = next[pid] || []
            const replaced = []
            const seen = new Set()
            for (const tag of list) {
              const val = tag.toLowerCase() === oldLower ? finalName : tag
              const key = String(val).toLowerCase()
              if (!seen.has(key)) { seen.add(key); replaced.push(val) }
            }
            next[pid] = replaced
          }
          return next
        })
      } catch (e) {
        console.error(e)
      } finally {
        setRenamingTag(null)
        setRenameValue('')
      }
    },
    [API_BASE, allTags]
  )

  const deleteTag = useCallback(
    async (name) => {
      const tag = (name || '').trim()
      if (!tag) { setTagMenu({ open: false, x: 0, y: 0, tag: null }); return }
      try {
        const resp = await fetch(`${API_BASE}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE', credentials: 'include' })
        if (!resp.ok) throw new Error('Delete tag failed')
        const json = await resp.json()
        const serverTags = (json && Array.isArray(json.tags)) ? json.tags.map((t) => t.name) : (allTags.filter((t) => t.toLowerCase() !== tag.toLowerCase()))
        setAllTags(serverTags)
        // remove from active filters
        setActiveTags((prev) => prev.filter((n) => n.toLowerCase() !== tag.toLowerCase()))
        // remove from per-photo tags
        setTagsById((prev) => {
          const next = { ...prev }
          for (const pid of Object.keys(next)) {
            const list = next[pid] || []
            next[pid] = list.filter((t) => t.toLowerCase() !== tag.toLowerCase())
          }
          return next
        })
      } catch (e) {
        console.error(e)
      } finally {
        setTagMenu({ open: false, x: 0, y: 0, tag: null })
        setConfirmDeleteTag(null)
      }
    },
    [API_BASE, allTags]
  )

  const deleteTags = useCallback(
    async (names) => {
      const list = Array.isArray(names) ? names : [names]
      const toDelete = Array.from(new Map(list.map((n) => [String(n).toLowerCase(), n])).values())
      try {
        for (const n of toDelete) {
          const tag = (n || '').trim()
          if (!tag) continue
          const resp = await fetch(`${API_BASE}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE', credentials: 'include' })
          if (!resp.ok) throw new Error('Delete tag failed')
        }
        // Refresh tags list from server once
        const tagsResp = await fetch(`${API_BASE}/tags`, { credentials: 'include' })
        if (tagsResp.ok) {
          const tagsJson = await tagsResp.json()
          setAllTags((tagsJson || []).map((t) => t.name))
        } else {
          // Fallback local removal
          setAllTags((prev) => prev.filter((t) => !toDelete.some((d) => d.toLowerCase() === t.toLowerCase())))
        }
        // remove from active filters
        setActiveTags((prev) => prev.filter((n) => !toDelete.some((d) => d.toLowerCase() === n.toLowerCase())))
        // remove from per-photo tags
        setTagsById((prev) => {
          const next = { ...prev }
          for (const pid of Object.keys(next)) {
            const list = next[pid] || []
            next[pid] = list.filter((t) => !toDelete.some((d) => d.toLowerCase() === t.toLowerCase()))
          }
          return next
        })
      } catch (e) {
        console.error(e)
      } finally {
        setTagMenu({ open: false, x: 0, y: 0, tag: null })
        setConfirmDeleteTag(null)
      }
    },
    [API_BASE]
  )

  const onTagInputKeyDown = useCallback(
    (e) => {
      // Shift+Space to accept autocomplete (not Ctrl+Space)
      if ((e.key === ' ' || e.key === 'Spacebar' || e.key === 'Space') && e.shiftKey && !e.ctrlKey) {
        if (suggestions.length > 0) {
          e.preventDefault()
          const pick = highlightedSuggestion >= 0 ? suggestions[highlightedSuggestion] : suggestions[0]
          if (pick) addTag(pick)
        }
        return
      }
      if (e.key === 'ArrowDown') {
        if (suggestions.length > 0) {
          e.preventDefault()
          setHighlightedSuggestion((i) => (i + 1) % suggestions.length)
        }
        return
      }
      if (e.key === 'ArrowUp') {
        if (suggestions.length > 0) {
          e.preventDefault()
          setHighlightedSuggestion((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
        }
        return
      }
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault()
        if (suggestions.length > 0 && highlightedSuggestion >= 0) {
          const pick = suggestions[highlightedSuggestion]
          if (pick) { addTag(pick); return }
        }
        if (tagInput.trim()) addTag(tagInput)
      } else if (e.key === 'Backspace' && !tagInput) {
        const last = selectedTags[selectedTags.length - 1]
        if (last) removeTag(last)
      }
    },
    [addTag, removeTag, selectedTags, tagInput, suggestions, highlightedSuggestion]
  )

  const markCompleted = useCallback(async () => {
    const current = filteredPhotos[selectedIndex]
    if (!current) return
    const nextIndex = Math.min(selectedIndex + 1, filteredPhotos.length - 1)
    try {
      if (!current.completed) {
        setPhotos((prev) => prev.map((p) => (p.id === current.id ? { ...p, completed: true } : p)))
        const resp = await fetch(`${API_BASE}/photos/${current.id}/complete`, { method: 'POST', credentials: 'include' })
        if (resp.ok) {
          const updated = await resp.json()
          setPhotos((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
        }
      } else {
        setPhotos((prev) => prev.map((p) => (p.id === current.id ? { ...p, completed: false } : p)))
        const resp = await fetch(`${API_BASE}/photos/${current.id}/incomplete`, { method: 'POST', credentials: 'include' })
        if (resp.ok) {
          const updated = await resp.json()
          setPhotos((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
        }
      }
    } catch (e) {
      console.error(e)
    } finally {
      // Only advance on marking complete, stay on same when unmarking
      if (!current.completed) {
        setSelectedIndex(nextIndex)
        setSelectedIndices(new Set([nextIndex]))
        setAnchorIndex(nextIndex)
      }
      try { await refreshStats() } catch {}
    }
  }, [API_BASE, filteredPhotos, selectedIndex, refreshStats])

  const handleArrowNavigation = useCallback(
    (event) => {
      if (event.key === 'Enter' && event.metaKey) {
        event.preventDefault()
        markCompleted()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && event.metaKey) {
        if (selectedIndices.size > 0) {
          setShowDelete(true)
        }
        return
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const hasShift = event.shiftKey
        setSelectedIndex((currentIndex) => {
          let delta = 0
          if (event.key === 'ArrowRight') delta = 1
          else if (event.key === 'ArrowLeft') delta = -1
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            // Compute columns from grid container
            const container = gridRef.current
            const style = container ? getComputedStyle(container) : null
            const gapPx = style ? parseInt(style.gap || style.gridColumnGap || '12', 10) : 12
            const paddingLeft = style ? parseInt(style.paddingLeft || '0', 10) : 0
            const paddingRight = style ? parseInt(style.paddingRight || '0', 10) : 0
            const innerWidth = container ? (container.clientWidth - paddingLeft - paddingRight) : 0
            const colWidth = 120
            const cols = Math.max(1, Math.floor((innerWidth + gapPx) / (colWidth + gapPx)))
            delta = (event.key === 'ArrowDown') ? cols : -cols
          }

          const nextIndex = Math.max(0, Math.min(currentIndex + delta, filteredPhotos.length - 1))
          if (hasShift) {
            const start = Math.min(anchorIndex ?? currentIndex, nextIndex)
            const end = Math.max(anchorIndex ?? currentIndex, nextIndex)
            const nextSet = new Set(selectedIndices)
            for (let i = start; i <= end; i++) nextSet.add(i)
            setSelectedIndices(nextSet)
          } else {
            setSelectedIndices(new Set([nextIndex]))
            setAnchorIndex(nextIndex)
          }
          return nextIndex
        })
      }
    },
    [anchorIndex, filteredPhotos.length, selectedIndices]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleArrowNavigation)
    return () => window.removeEventListener('keydown', handleArrowNavigation)
  }, [handleArrowNavigation])

  useEffect(() => {
    const selectedElement = document.querySelector(`.thumb-btn[data-index="${selectedIndex}"]`)
    if (selectedElement && 'scrollIntoView' in selectedElement) {
      selectedElement.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [selectedIndex])

  // Preload next/previous preview images for smoother nav
  useEffect(() => {
    if (!selected) return
    const preload = (p) => {
      if (!p) return
      const img = new Image()
      img.src = p.url || `${API_BASE}/uploads/${p.filename}`
    }
    preload(filteredPhotos[selectedIndex + 1])
    preload(filteredPhotos[selectedIndex - 1])
  }, [API_BASE, filteredPhotos, selected, selectedIndex])

  // No virtualization sizing listeners needed

  // Initial load: fetch first page and tags
  const loadCoreData = useCallback(async () => {
    try {
      const [photosResp, tagsResp] = await Promise.all([
        fetch(`${API_BASE}/photos?limit=50`, { credentials: 'include' }),
        fetch(`${API_BASE}/tags`, { credentials: 'include' })
      ])
      const photosJson = photosResp.ok ? await photosResp.json() : { items: [] }
      const tagsJson = tagsResp.ok ? await tagsResp.json() : []
      const firstItems = Array.isArray(photosJson) ? photosJson : photosJson.items || []
      setPhotos(firstItems)
      setNextCursor(photosJson.nextCursor || null)
      const initialMap = {}
      for (const p of firstItems || []) {
        initialMap[p.id] = Array.isArray(p.tags) ? p.tags : []
      }
      setTagsById(initialMap)
      setAllTags((tagsJson || []).map((t) => t.name))
    } catch (e) {
      console.error('Failed to load data', e)
    }
  }, [API_BASE])

  const loadEvents = useCallback(async () => {
    try {
      const resp = await fetch(`${API_BASE}/events`, { credentials: 'include' })
      if (!resp.ok) return
      const json = await resp.json()
      setEvents(json || [])
    } catch (e) { console.error(e) }
  }, [API_BASE])

  const loadSettingsAndEvents = useCallback(async () => {
    try {
      const [settingsResp, eventsResp] = await Promise.all([
        fetch(`${API_BASE}/settings`, { credentials: 'include' }),
        fetch(`${API_BASE}/events`, { credentials: 'include' })
      ])
      if (eventsResp.ok) setEvents(await eventsResp.json())
      if (settingsResp.ok) {
        const s = await settingsResp.json()
        setSettingsPrompt(s.system_prompt || '')
        setSettingsModel(s.model || 'gpt-4o-mini')
        if (s.current_event_id) setCurrentEventId(s.current_event_id)
        if (s.current_event_name) setCurrentEventName(s.current_event_name)
      }
    } catch (e) { console.error(e) }
  }, [API_BASE])

  useEffect(() => {
    loadSettingsAndEvents()
  }, [loadSettingsAndEvents])

  useEffect(() => {
    loadCoreData()
    refreshStats()
  }, [API_BASE, currentEventId, loadCoreData, refreshStats])

  // Detect /share/:token and initialize person view flow
  useEffect(() => {
    try {
      const path = window.location.pathname || ''
      const parts = path.split('/').filter(Boolean)
      if (parts[0] === 'share' && parts[1]) {
        const token = parts[1]
        setShareToken(token)
        ;(async () => {
          try {
            if (shareInitRef.current) return
            shareInitRef.current = true
            // Prefetch public info for nicer UX
            try {
              const info = await fetch(`${API_BASE}/share/${token}/info`, { credentials: 'include' })
              if (info.ok) {
                const ij = await info.json()
                setPersonTagName(ij.tag_name || '')
                setPersonEventName(ij.event_name || '')
              }
            } catch {}
            const me = await fetch(`${API_BASE}/me`, { credentials: 'include' })
            const mj = me.ok ? await me.json() : { personScope: null }
            if (mj.personScope) {
              setIsPersonView(true)
              // Load the single tag name
              const tr = await fetch(`${API_BASE}/tags`, { credentials: 'include' })
              if (tr.ok) {
                const list = await tr.json()
                if (Array.isArray(list) && list[0]) {
                  const tname = list[0].name || ''
                  setPersonTagName(tname)
                  setActiveTags([tname])
                }
              }
              await loadCoreData()
              await refreshStats()
            } else {
              if (!personLoginDoneRef.current) setShowPersonLogin(true)
            }
          } catch {}
        })()
      } else {
        setIsPersonView(false)
      }
    } catch {}
  }, [])

  // Infinite scroll loader
  const loadMore = useCallback(async () => {
    if (!nextCursor || isLoadingPage) return
    try {
      setIsLoadingPage(true)
      const resp = await fetch(`${API_BASE}/photos?limit=50&cursor=${encodeURIComponent(nextCursor)}`, { credentials: 'include' })
      if (!resp.ok) return
      const json = await resp.json()
      const items = Array.isArray(json) ? json : json.items || []
      setPhotos((prev) => [...prev, ...items])
      setNextCursor(json.nextCursor || null)
      setTagsById((prev) => {
        const map = { ...prev }
        for (const p of items) map[p.id] = Array.isArray(p.tags) ? p.tags : []
        return map
      })
    } finally {
      setIsLoadingPage(false)
    }
  }, [API_BASE, isLoadingPage, nextCursor])

  useEffect(() => {
    refreshStats()
  }, [refreshStats, filteredPhotos.length])

  useEffect(() => {
    refreshStats()
  }, [activeTags, refreshStats])

  // Delete modal state
  const [showDelete, setShowDelete] = useState(false)
  const deleteCount = selectedIndices.size
  const [showSettings, setShowSettings] = useState(false)
  const [settingsPrompt, setSettingsPrompt] = useState('')
  const [settingsModel, setSettingsModel] = useState('gpt-4o-mini')
  const [personPasswordInput, setPersonPasswordInput] = useState('')
  const [isSavingPersonPassword, setIsSavingPersonPassword] = useState(false)
  const [shareLinks, setShareLinks] = useState([])
  const [isLoadingShareLinks, setIsLoadingShareLinks] = useState(false)
  const [linkTagToCreate, setLinkTagToCreate] = useState('')
  const [isCreatingLink, setIsCreatingLink] = useState(false)
  const [showShareManager, setShowShareManager] = useState(false)

  const loadSettings = useCallback(async () => {
    try {
      const resp = await fetch(`${API_BASE}/settings`, { credentials: 'include' })
      if (!resp.ok) return
      const json = await resp.json()
      setSettingsPrompt(json.system_prompt || '')
      setSettingsModel(json.model || 'gpt-4o-mini')
      if (json.current_event_id) setCurrentEventId(json.current_event_id)
      if (json.current_event_name) setCurrentEventName(json.current_event_name)
      await loadEvents()
      // load share links
      try {
        setIsLoadingShareLinks(true)
        const rl = await fetch(`${API_BASE}/share-links`, { credentials: 'include' })
        if (rl.ok) setShareLinks(await rl.json())
      } catch (e) { console.error(e) } finally { setIsLoadingShareLinks(false) }
    } catch (e) { console.error(e) }
  }, [API_BASE, loadEvents])

  const saveSettings = useCallback(async () => {
    try {
      const resp = await fetch(`${API_BASE}/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_prompt: settingsPrompt, model: settingsModel }),
        credentials: 'include'
      })
      if (resp.ok) setShowSettings(false)
    } catch (e) { console.error(e) }
  }, [API_BASE, settingsPrompt, settingsModel])

  const savePersonPassword = useCallback(async () => {
    try {
      setIsSavingPersonPassword(true)
      const resp = await fetch(`${API_BASE}/settings/person-view-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: personPasswordInput || null }),
        credentials: 'include'
      })
      if (resp.ok) setPersonPasswordInput('')
    } catch (e) { console.error(e) }
    finally { setIsSavingPersonPassword(false) }
  }, [API_BASE, personPasswordInput])

  const refreshShareLinks = useCallback(async () => {
    try {
      setIsLoadingShareLinks(true)
      const rl = await fetch(`${API_BASE}/share-links`, { credentials: 'include' })
      if (rl.ok) setShareLinks(await rl.json())
    } catch (e) { console.error(e) } finally { setIsLoadingShareLinks(false) }
  }, [API_BASE])

  const createShareLink = useCallback(async () => {
    const tagName = (linkTagToCreate || '').trim()
    if (!tagName) return
    try {
      setIsCreatingLink(true)
      const resp = await fetch(`${API_BASE}/share-links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag_name: tagName }), credentials: 'include' })
      if (!resp.ok) throw new Error('Failed to create link')
      await refreshShareLinks()
    } catch (e) { console.error(e) } finally { setIsCreatingLink(false) }
  }, [API_BASE, linkTagToCreate, refreshShareLinks])

  const revokeShareLink = useCallback(async (id) => {
    try {
      const resp = await fetch(`${API_BASE}/share-links/${id}`, { method: 'DELETE', credentials: 'include' })
      if (!resp.ok) throw new Error('Failed to revoke')
      await refreshShareLinks()
    } catch (e) { console.error(e) }
  }, [API_BASE, refreshShareLinks])

  const setCurrentEvent = useCallback(async (eventId, fallbackName) => {
    try {
      const resp = await fetch(`${API_BASE}/settings/event`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: eventId }),
        credentials: 'include'
      })
      if (resp.ok) {
        setCurrentEventId(eventId)
        const found = events.find((e) => e.id === eventId)
        setCurrentEventName(found?.name || fallbackName || currentEventName)
        await loadCoreData()
        await refreshStats()
      }
    } catch (e) { console.error(e) }
  }, [API_BASE, events, loadCoreData, refreshStats, currentEventName])

  const createEventSubmit = useCallback(async () => {
    const name = (newEventName || '').trim()
    if (!name) return
    try {
      setIsCreatingEvent(true)
      const resp = await fetch(`${API_BASE}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }), credentials: 'include' })
      if (!resp.ok) throw new Error('Failed to create event')
      const ev = await resp.json()
      setEvents((prev) => (Array.isArray(prev) ? [...prev, ev] : [ev]))
      await setCurrentEvent(ev.id, ev.name)
      setShowNewEvent(false)
      setShowSettings(false)
      setReopenSettingsOnEventCancel(false)
    } catch (e) { console.error(e) }
    finally { setIsCreatingEvent(false) }
  }, [API_BASE, newEventName, setCurrentEvent])

  const cancelNewEventModal = useCallback(() => {
    setShowNewEvent(false)
    if (reopenSettingsOnEventCancel) setShowSettings(true)
    setReopenSettingsOnEventCancel(false)
  }, [reopenSettingsOnEventCancel])

  const openDeleteEventModal = useCallback(() => {
    if (!currentEventId) return
    if (String(currentEventName).toLowerCase() === 'default') return
    setReopenSettingsOnDeleteCancel(true)
    setShowSettings(false)
    setShowDeleteEvent(true)
  }, [currentEventId, currentEventName])

  const cancelDeleteEventModal = useCallback(() => {
    setShowDeleteEvent(false)
    if (reopenSettingsOnDeleteCancel) setShowSettings(true)
    setReopenSettingsOnDeleteCancel(false)
  }, [reopenSettingsOnDeleteCancel])

  const deleteEventSubmit = useCallback(async () => {
    if (!currentEventId) return
    if (String(currentEventName).toLowerCase() === 'default') return
    try {
      setIsDeletingEvent(true)
      const resp = await fetch(`${API_BASE}/events/${currentEventId}`, { method: 'DELETE', credentials: 'include' })
      if (!resp.ok) throw new Error('Failed to delete event')
      await loadSettingsAndEvents()
      await loadCoreData()
      await refreshStats()
      setShowDeleteEvent(false)
      setShowSettings(false)
      setReopenSettingsOnDeleteCancel(false)
    } catch (e) { console.error(e) }
    finally { setIsDeletingEvent(false) }
  }, [API_BASE, currentEventId, currentEventName, loadCoreData, loadSettingsAndEvents, refreshStats])

  const [isDescribing, setIsDescribing] = useState(false)
  const [isIdentifying, setIsIdentifying] = useState(false)
  const [showPeopleModal, setShowPeopleModal] = useState(false)
  const [detectedPeople, setDetectedPeople] = useState({ boxes: [], imageWidth: 0, imageHeight: 0 })
  const generateDescription = useCallback(async () => {
    if (!selected?.id) return
    setIsDescribing(true)
    try {
      const resp = await fetch(`${API_BASE}/photos/${selected.id}/describe`, { method: 'POST', credentials: 'include' })
      if (!resp.ok) throw new Error('Describe failed')
      const updated = await resp.json()
      setPhotos((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
    } catch (e) {
      console.error(e)
    } finally {
      setIsDescribing(false)
    }
  }, [API_BASE, selected])

  const identifyPeople = useCallback(async () => {
    if (!selected?.id) return
    try {
      setIsIdentifying(true)
      const resp = await fetch(`${API_BASE}/photos/${selected.id}/detect-people`, { method: 'POST', credentials: 'include' })
      const json = resp.ok ? await resp.json() : { boxes: [], imageWidth: 0, imageHeight: 0 }
      setDetectedPeople(json)
      setShowPeopleModal(true)
    } catch (e) {
      console.error(e)
      setDetectedPeople({ boxes: [], imageWidth: 0, imageHeight: 0 })
      setShowPeopleModal(true)
    } finally {
      setIsIdentifying(false)
    }
  }, [API_BASE, selected])
  const confirmDelete = useCallback(async () => {
    try {
      const ids = Array.from(selectedIndices).map((i) => filteredPhotos[i]?.id).filter(Boolean)
      if (ids.length === 0) return
      const resp = await fetch(`${API_BASE}/photos`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
        credentials: 'include'
      })
      if (!resp.ok) throw new Error('Delete failed')
      setPhotos((prev) => prev.filter((p) => !ids.includes(p.id)))
      setSelectedIndices(new Set())
      setSelectedIndex(0)
    } catch (e) {
      console.error(e)
    } finally {
      setShowDelete(false)
      try { await refreshStats() } catch {}
    }
  }, [API_BASE, filteredPhotos, selectedIndices, refreshStats])

  useEffect(() => {
    const onResize = () => {
      const img = previewImgRef.current
      if (!img) return
      setPreviewSize({ w: img.clientWidth || 0, h: img.clientHeight || 0 })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    // Load stored faces for selected photo
    (async () => {
      try {
        if (!selected?.id) { setFaces([]); return }
        const r = await fetch(`${API_BASE}/photos/${selected.id}/faces`, { credentials: 'include' })
        if (r.ok) {
          const js = await r.json()
          setFaces(Array.isArray(js) ? js : [])
        }
        // update size
        const img = previewImgRef.current
        if (img) setPreviewSize({ w: img.clientWidth || 0, h: img.clientHeight || 0 })
      } catch (e) { console.error(e) }
    })()
  }, [API_BASE, selected])

  return (
    <>
      <header className="topbar">
        <div className="brand">Photo Classification App</div>
        {!isPersonView && (
          <div className="event-chip" title="Current event">{currentEventName}</div>
        )}
        {isPersonView && (
          <div className="event-chip" title="Personal album">{personTagName ? `Personal album: ${personTagName}` : 'Personal album'}</div>
        )}
        <div className="topbar-actions">
          <span className="counter" title="Completed / Total in gallery">{completedCount}/{stats.total}</span>
          {!isPersonView && (
            <button className="gear-btn" onClick={() => { setShowSettings(true); loadSettings() }} title="Settings">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M9.5 3h5l.6 2.4a6.9 6.9 0 0 1 1.9 1.1L19.4 6l3 5.2-1.8 1.3c.1.8.1 1.7 0 2.5l1.8 1.3-3 5.2-2.4-.5a6.9 6.9 0 0 1-1.9 1.1L14.5 23h-5l-.6-2.4a6.9 6.9 0 0 1-1.9-1.1L4.6 21l-3-5.2 1.8-1.3a8.9 8.9 0 0 1 0-2.5L1.6 11 4.6 5.8l2.4.5c.6-.5 1.2-.8 1.9-1.1L9.5 3Zm2.5 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
            </button>
          )}
          {isPersonView && (
            <button className="describe-btn" onClick={async () => { try { await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' }); window.location.href = '/' } catch {} }}>Sign out</button>
          )}
          <button
            className="download-btn"
            onClick={async () => {
              if (!activeTags || activeTags.length !== 1) return
              try {
                const onlyTag = activeTags[0]
                const resp = await fetch(`${API_BASE}/download?tag=${encodeURIComponent(onlyTag)}`, { credentials: 'include' })
                if (!resp.ok) throw new Error('Download failed')
                const blob = await resp.blob()
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `photos_${onlyTag}.zip`
                document.body.appendChild(a)
                a.click()
                a.remove()
                URL.revokeObjectURL(url)
              } catch (err) {
                console.error(err)
              }
            }}
            disabled={!activeTags || activeTags.length !== 1}
            title={activeTags && activeTags.length === 1 ? `Download all photos tagged '${activeTags[0]}'` : 'Select exactly one tag to enable download'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M12 4v10m0 0l-4-4m4 4l4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M20 20H4a2 2 0 0 1-2-2v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span className="upload-text">Download</span>
          </button>
          <input
            id="file-input"
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={async (e) => {
              const files = Array.from(e.target.files || [])
              if (!files.length) return
              const capped = files.slice(0, 2000)
              setIsBulkUploading(true)
              setBulkTotal(capped.length)
              setBulkDone(0)
              setIsUploading(true)
              try {
                const concurrency = Math.min(6, capped.length)
                let index = 0
                const uploadOne = async (file) => {
                  const fd = new FormData()
                  fd.append('photo', file)
                  const resp = await fetch(`${API_BASE}/photos`, { method: 'POST', body: fd, credentials: 'include' })
                  if (!resp.ok) throw new Error('Upload failed')
                  const created = await resp.json()
                  setPhotos((prev) => [created, ...prev])
                  setTagsById((prev) => ({ ...prev, [created.id]: created.tags || [] }))
                  setBulkDone((d) => d + 1)
                }
                const worker = async () => {
                  while (true) {
                    const i = index
                    if (i >= capped.length) break
                    index = i + 1
                    const file = capped[i]
                    try { await uploadOne(file) } catch (err) { console.error(err) }
                  }
                }
                await Promise.all(Array.from({ length: concurrency }, worker))
                setSelectedIndex(0)
              } catch (err) {
                console.error(err)
              } finally {
                setIsUploading(false)
                setIsBulkUploading(false)
                e.target.value = ''
              }
            }}
          />
          {!isPersonView && (
          <button
            className="upload-btn"
            onClick={() => document.getElementById('file-input')?.click()}
            disabled={isUploading}
            title={isUploading ? 'Uploading…' : 'Upload photo'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M12 16V4m0 0l-4 4m4-4l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M20 16v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span className="upload-text">{isUploading ? 'Uploading…' : 'Upload'}</span>
          </button>
          )}
      </div>
      </header>
      <div className="app-container">
      {!isPersonView && (
      <nav
        className="tag-rail"
        ref={tagRailRef}
        tabIndex={0}
        onKeyDown={(e) => {
          // Handle Up/Down navigation inside tag rail with multi-select
          const { key, shiftKey } = e
          if (key !== 'ArrowUp' && key !== 'ArrowDown') return
          if (!Array.isArray(allTags) || allTags.length === 0) return
          e.preventDefault()
          e.stopPropagation()
          const currentIndex = (() => {
            // prefer last anchor, else use first selected, else 0
            if (tagAnchorIndex !== null && tagAnchorIndex >= 0 && tagAnchorIndex < allTags.length) return tagAnchorIndex
            if (activeTags.length > 0) {
              const idx = allTags.findIndex((t) => t.toLowerCase() === String(activeTags[activeTags.length - 1]).toLowerCase())
              return idx >= 0 ? idx : 0
            }
            return 0
          })()
          const delta = key === 'ArrowDown' ? 1 : -1
          const nextIndex = Math.max(0, Math.min(currentIndex + delta, allTags.length - 1))
          const nextTag = allTags[nextIndex]
          if (shiftKey) {
            const start = Math.min(tagAnchorIndex ?? currentIndex, nextIndex)
            const end = Math.max(tagAnchorIndex ?? currentIndex, nextIndex)
            const range = new Set(activeTags.map((t) => t))
            for (let i = start; i <= end; i++) range.add(allTags[i])
            setActiveTags(Array.from(range))
            setTagAnchorIndex(start)
          } else {
            setActiveTags([nextTag])
            setTagAnchorIndex(nextIndex)
          }
        }}
      >
        <div className="tag-rail-header">Tags</div>
        <button
          className={`tag-rail-item ${!activeTags || activeTags.length === 0 ? 'active' : ''}`}
          onClick={() => { setActiveTags([]); setTagAnchorIndex(null); }}
        >
          All
        </button>
        {allTags.map((t) => (
          <div key={t} style={{ display: 'contents' }}>
          {renamingTag && renamingTag.toLowerCase() === t.toLowerCase() ? (
            <input
              className="tag-rail-item"
              style={{ width: '100%' }}
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); renameTag(t, renameValue) }
                if (e.key === 'Escape') { e.preventDefault(); setRenamingTag(null); setRenameValue('') }
              }}
              title={`Rename ${t}`}
            />
          ) : (
          <button
            className={`tag-rail-item ${activeTags.some((s) => s.toLowerCase() === t.toLowerCase()) ? 'active' : ''}`}
            onContextMenu={(e) => {
              e.preventDefault()
              // If multiple selected and right-clicked tag not in selection, select only this one
              const inSelection = activeTags.some((s) => s.toLowerCase() === t.toLowerCase())
              if (!inSelection && activeTags.length > 1) {
                setActiveTags([t])
                setTagAnchorIndex(allTags.findIndex((x) => x === t))
              }
              setTagMenu({ open: true, x: e.clientX, y: e.clientY, tag: t })
            }}
            onClick={(e) => {
              // Click, Shift+Click, Ctrl/Cmd+Click behavior
              const idx = allTags.findIndex((x) => x === t)
              if (e.shiftKey) {
                const base = tagAnchorIndex ?? idx
                const start = Math.min(base, idx)
                const end = Math.max(base, idx)
                const next = new Set(activeTags)
                for (let i = start; i <= end; i++) next.add(allTags[i])
                setActiveTags(Array.from(next))
                setTagAnchorIndex(base)
              } else if (e.ctrlKey || e.metaKey) {
                const exists = activeTags.some((s) => s.toLowerCase() === t.toLowerCase())
                if (exists) {
                  const next = activeTags.filter((s) => s.toLowerCase() !== t.toLowerCase())
                  setActiveTags(next)
                } else {
                  setActiveTags([...activeTags, t])
                }
                setTagAnchorIndex(idx)
              } else {
                setActiveTags([t])
                setTagAnchorIndex(idx)
              }
              setSelectedIndex(0)
              // ensure tag rail can receive keyboard events
              setTimeout(() => tagRailRef.current && tagRailRef.current.focus(), 0)
            }}
            title={t}
          >
            {t}
          </button>
          )}
          </div>
        ))}
      </nav>
      )}
      <aside className="sidebar">
        <div className="thumb-grid" ref={gridRef} onScroll={(e) => {
          const el = e.currentTarget
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
            loadMore()
          }
        }}>
          {filteredPhotos.map((p, idx) => {
            const isSelected = selectedIndices.has(idx) || idx === selectedIndex
            return (
              <button
                key={p.id}
                data-index={idx}
                className={`thumb-btn ${isSelected ? 'selected' : ''}`}
                onClick={(e) => {
                  if (e.shiftKey) {
                    const start = Math.max(0, Math.min(anchorIndex ?? 0, idx))
                    const end = Math.max(anchorIndex ?? 0, idx)
                    const next = new Set(selectedIndices)
                    for (let i = start; i <= end; i++) next.add(i)
                    setSelectedIndices(next)
                    setSelectedIndex(idx)
                  } else if (e.ctrlKey || e.metaKey) {
                    const next = new Set(selectedIndices)
                    if (next.has(idx)) next.delete(idx); else next.add(idx)
                    setSelectedIndices(next)
                    setSelectedIndex(idx)
                    setAnchorIndex(idx)
                  } else {
                    setSelectedIndices(new Set([idx]))
                    setSelectedIndex(idx)
                    setAnchorIndex(idx)
                  }
                }}
                title={p.title}
              >
                <img
                  className="thumb-img"
                  src={p.thumb_filename ? `${API_BASE}/uploads/${p.thumb_filename}` : (p.url || `${API_BASE}/uploads/${p.filename}`)}
                  alt={p.title || p.original_name || `Photo ${p.id}`}
                  loading="lazy"
                />
                {p.completed && (
                  <span className="thumb-check" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M9 12.5l2 2 4-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" fill="none"/>
                    </svg>
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </aside>

      <main className="preview-pane">
        <div className="actions">
          {!isPersonView && (
          <button
            className={`icon-btn ${selected?.completed ? 'completed' : 'mark-btn'}`}
            onClick={() => markCompleted()}
            title={selected?.completed ? 'Completed (click to unmark)' : 'Mark as completed (Cmd+Enter)'}
            disabled={!selected}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M9 12.5l2 2 4-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" fill="none"/>
            </svg>
            {selected?.completed && <span className="btn-label">Completed</span>}
          </button>
          )}
          {!isPersonView && (
          <button className="describe-btn" onClick={generateDescription} disabled={!selected || isDescribing} title="Generate Description">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M4 19h6l5 3v-3h5V2H4v17Z" stroke="currentColor" strokeWidth="1.6"/>
            </svg>
            <span>{isDescribing ? 'Describing…' : 'Describe'}</span>
          </button>
          )}
          {!isPersonView && (
          <button
            className="describe-btn"
            onClick={identifyPeople}
            disabled={!selected || isIdentifying}
            title="Identify People"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" stroke="currentColor" strokeWidth="1.6"/>
              <path d="M4 20a8 8 0 0 1 16 0" stroke="currentColor" strokeWidth="1.6"/>
            </svg>
            <span>{isIdentifying ? 'Identifying…' : 'Identify'}</span>
          </button>
          )}
          {!isPersonView && (
          <button
            className="icon-btn"
            onClick={() => setShowDelete(true)}
            title="Delete (Cmd+Delete)"
            disabled={selectedIndices.size === 0}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M3 6h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            {selectedIndices.size > 1 && (
              <span className="trash-badge">{selectedIndices.size}</span>
            )}
          </button>
          )}
        </div>
        <div className="preview-area">
          {selected && (
            <img
              className="preview-img"
              ref={previewImgRef}
              src={selected.preview_filename ? `${API_BASE}/uploads/${selected.preview_filename}` : (selected.url || `${API_BASE}/uploads/${selected.filename}`)}
              alt={selected.title || selected.original_name || `Photo ${selected.id}`}
            />
          )}
          {faces && faces.length > 0 && (
            <div className="face-overlay">
              {faces.map((f) => {
                const b = f?.bbox || {}
                // We assume bbox is in original image pixels; scale to preview
                const scaleX = (previewImgRef.current?.clientWidth || 0) / (selected?.width || previewImgRef.current?.naturalWidth || 1)
                const scaleY = (previewImgRef.current?.clientHeight || 0) / (selected?.height || previewImgRef.current?.naturalHeight || 1)
                const left = Math.max(0, Math.round((b.left || 0) * (isFinite(scaleX) ? scaleX : 1)))
                const top = Math.max(0, Math.round((b.top || 0) * (isFinite(scaleY) ? scaleY : 1)))
                const width = Math.max(0, Math.round((b.width || 0) * (isFinite(scaleX) ? scaleX : 1)))
                const height = Math.max(0, Math.round((b.height || 0) * (isFinite(scaleY) ? scaleY : 1)))
                return (
                  <div key={f.id} className="face-box" style={{ left, top, width, height }} />
                )
              })}
            </div>
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
                      {suggestions.map((s, idx) => (
                        <li key={s}>
                          <button
                            type="button"
                            className={`suggestion-btn ${idx === highlightedSuggestion ? 'active' : ''}`}
                            onMouseEnter={() => setHighlightedSuggestion(idx)}
                            onClick={() => addTag(s)}
                          >{s}</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              <div className="detail"><span className="label">Description</span><span className="value">{selected.description || ''}</span></div>
            </div>
          ) : (
            <div className="details-empty">Select a photo to see details</div>
          )}
        </section>
      </main>
    </div>
    {isBulkUploading && (
      <div className="modal-overlay" role="alert" aria-live="assertive">
        <div className="modal-card">
          <div className="modal-title">Uploading Photos</div>
          <div className="modal-subtitle">Photos: {bulkDone}/{bulkTotal}</div>
          <div className="progress-outer"><div className="progress-inner" style={{ width: `${Math.min(100, Math.round((bulkDone / Math.max(1, bulkTotal)) * 100))}%` }} /></div>
        </div>
      </div>
    )}
    {showDelete && (
      <div className="modal-overlay" role="dialog" aria-modal="true" onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); confirmDelete(); }
        if (e.key === 'Escape') { e.preventDefault(); setShowDelete(false); }
      }}>
        <div className="modal-card">
          <div className="modal-title">Delete photos</div>
          <div className="modal-subtitle">You are about to delete {deleteCount} {deleteCount === 1 ? 'photo' : 'photos'}. This action cannot be undone.</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="suggestion-btn" onClick={() => setShowDelete(false)}>Cancel (Esc)</button>
            <button className="suggestion-btn" onClick={confirmDelete} autoFocus>Delete (Enter)</button>
          </div>
        </div>
      </div>
    )}
    {showSettings && (
      <div className="modal-overlay settings-modal" role="dialog" aria-modal="true">
        <div className="modal-card">
          <div className="modal-title">Settings</div>
          <div className="settings-row">
            <label>Event</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select className="settings-select" value={currentEventId || ''} onChange={(e) => setCurrentEvent(parseInt(e.target.value))}>
                {events.map((ev) => (
                  <option key={ev.id} value={ev.id}>{ev.name}</option>
                ))}
              </select>
              <button className="describe-btn" onClick={() => { setNewEventName(''); setReopenSettingsOnEventCancel(true); setShowSettings(false); setShowNewEvent(true) }}>New</button>
            </div>
          </div>
          <div className="settings-row">
            <label>Model</label>
            <select className="settings-select" value={settingsModel} onChange={(e) => setSettingsModel(e.target.value)}>
              <option value="gpt-4o-mini">gpt-4o-mini (recommended)</option>
              <option value="gpt-4o">gpt-4o</option>
              <option value="gpt-4o-mini-high">gpt-4o-mini-high</option>
            </select>
          </div>
          <div className="settings-row">
            <label>Person View Password</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
              <input className="settings-input" type="password" placeholder="Set or change password" value={personPasswordInput} onChange={(e) => setPersonPasswordInput(e.target.value)} />
              <button className="describe-btn" onClick={savePersonPassword} disabled={isSavingPersonPassword}>{isSavingPersonPassword ? 'Saving…' : 'Save'}</button>
              <button className="describe-btn" onClick={async () => { setPersonPasswordInput(''); await savePersonPassword() }}>Clear</button>
            </div>
          </div>
          <div className="settings-row">
            <label>System Prompt</label>
            <textarea className="settings-input" rows={6} value={settingsPrompt} onChange={(e) => setSettingsPrompt(e.target.value)} placeholder="You are a helpful photo captioning assistant..." />
          </div>
          <div className="settings-actions" style={{ justifyContent: 'space-between' }}>
            <button className="suggestion-btn" style={{ color: '#b91c1c', borderColor: '#fecaca' }} onClick={openDeleteEventModal} disabled={String(currentEventName).toLowerCase()==='default'}>Delete event</button>
            <div style={{ display:'flex', gap:8 }}>
              <button className="suggestion-btn" onClick={() => setShowSettings(false)}>Cancel</button>
              <button className="suggestion-btn" onClick={saveSettings}>Save</button>
            </div>
          </div>
          <div className="modal-title" style={{ marginTop: 12 }}>Share Links</div>
          <div className="settings-row">
            <label>Manage</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="describe-btn" onClick={() => { setShowSettings(false); setShowShareManager(true); refreshShareLinks() }}>Open Manager</button>
            </div>
          </div>
        </div>
      </div>
    )}
    {showNewEvent && (
      <div className="modal-overlay" role="dialog" aria-modal="true" onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); createEventSubmit() }
        if (e.key === 'Escape') { e.preventDefault(); cancelNewEventModal() }
      }}>
        <div className="modal-card">
          <div className="modal-title">Create new event</div>
          <div className="settings-row">
            <label>Name</label>
            <input className="settings-input" value={newEventName} onChange={(e) => setNewEventName(e.target.value)} placeholder="Event name" />
          </div>
          <div className="settings-actions">
            <button className="suggestion-btn" onClick={cancelNewEventModal}>Cancel</button>
            <button className="suggestion-btn" onClick={createEventSubmit} disabled={!newEventName.trim() || isCreatingEvent}>{isCreatingEvent ? 'Creating…' : 'Create'}</button>
          </div>
        </div>
      </div>
    )}
    {showDeleteEvent && (
      <div className="modal-overlay" role="dialog" aria-modal="true" onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); deleteEventSubmit() }
        if (e.key === 'Escape') { e.preventDefault(); cancelDeleteEventModal() }
      }}>
        <div className="modal-card">
          <div className="modal-title">Delete event</div>
          <div className="modal-subtitle">You are about to delete the event "{currentEventName}" and all of its photos and tags. This action cannot be undone.</div>
          <div className="settings-actions">
            <button className="suggestion-btn" onClick={cancelDeleteEventModal}>Cancel</button>
            <button className="suggestion-btn" onClick={deleteEventSubmit} disabled={isDeletingEvent}>{isDeletingEvent ? 'Deleting…' : 'Delete'}</button>
          </div>
        </div>
      </div>
    )}
    {showPeopleModal && (
      <div className="modal-overlay" role="dialog" aria-modal="true">
        <div className="modal-card">
          <div className="modal-title">People detected</div>
          <div className="modal-subtitle">
            {Array.isArray(detectedPeople?.boxes) ? `${detectedPeople.boxes.length} person${detectedPeople.boxes.length===1?'':'s'} found` : 'No data'}
          </div>
          <div style={{ maxHeight: 240, overflow: 'auto', marginTop: 8 }}>
            <ul style={{ paddingLeft: 16 }}>
              {(detectedPeople?.boxes||[]).map((b, i) => (
                <li key={i}>#{i+1}: left={b.left}, top={b.top}, width={b.width}, height={b.height}, score={(b.score||0).toFixed?.(2) ?? b.score}</li>
              ))}
            </ul>
          </div>
          <div className="settings-actions">
            <button className="suggestion-btn" onClick={() => setShowPeopleModal(false)}>Ok</button>
          </div>
        </div>
      </div>
    )}
    {showPersonLogin && (
      <div className="modal-overlay" role="dialog" aria-modal="true" onKeyDown={async (e) => {
        if (e.key === 'Enter') { e.preventDefault(); try { const r = await fetch(`${API_BASE}/share/${shareToken}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: personPassword }), credentials: 'include' }); if (r.ok) { setShowPersonLogin(false); setIsPersonView(true); setPersonPassword(''); personLoginDoneRef.current = true; const tr = await fetch(`${API_BASE}/tags`, { credentials: 'include' }); if (tr.ok) { const list = await tr.json(); if (Array.isArray(list) && list[0]) { const tname = list[0].name || ''; setPersonTagName(tname); setActiveTags([tname]); } } await loadCoreData(); await refreshStats(); } } catch {} }
        if (e.key === 'Escape') { e.preventDefault(); /* remain on page */ }
      }}>
        <div className="modal-card">
          <div className="modal-title">Enter password</div>
          { (personTagName || personEventName) && (
            <div className="modal-subtitle">Album: {personTagName}{personEventName ? ` — ${personEventName}` : ''}</div>
          )}
          <div className="settings-row">
            <label>Password</label>
            <input className="settings-input" type="password" value={personPassword} onChange={(e) => setPersonPassword(e.target.value)} placeholder="Person View Password" disabled={isSubmittingLogin} />
          </div>
          {personLoginError && <div className="modal-subtitle" style={{ color: '#b91c1c' }}>{personLoginError}</div>}
          <div className="settings-actions" style={{ justifyContent: 'flex-end' }}>
            <button className="suggestion-btn" disabled={isSubmittingLogin || !personPassword.trim()} onClick={async () => {
              try {
                setIsSubmittingLogin(true)
                setPersonLoginError('')
                const r = await fetch(`${API_BASE}/share/${shareToken}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: personPassword }), credentials: 'include' })
                if (r.ok) {
                  setShowPersonLogin(false); setIsPersonView(true); setPersonPassword('');
                  personLoginDoneRef.current = true
                  // Refresh core and tags, set active filter to scoped tag
                  const tr = await fetch(`${API_BASE}/tags`, { credentials: 'include' })
                  if (tr.ok) {
                    const list = await tr.json()
                    if (Array.isArray(list) && list[0]) {
                      const tname = list[0].name || ''
                      setPersonTagName(tname)
                      setActiveTags([tname])
                    }
                  }
                  await loadCoreData(); await refreshStats();
                } else {
                  let msg = 'Login failed'
                  try {
                    const ej = await r.json()
                    if (ej?.code === 'INVALID_PASSWORD') msg = `Invalid password${(typeof ej.remaining_attempts==='number') ? ` — attempts left: ${ej.remaining_attempts}` : ''}`
                    else if (ej?.code === 'RATE_LIMIT') msg = `Too many attempts. Try again later${(typeof ej.retry_after==='number') ? ` (~${ej.retry_after}s)` : ''}.`
                    else if (ej?.code === 'INVALID_LINK') msg = 'This link is invalid or revoked.'
                    else if (ej?.code === 'LINK_EXPIRED') msg = 'This link has expired.'
                    else if (ej?.code === 'PASSWORD_NOT_SET') msg = 'Access not configured. Please contact the owner.'
                    else if (ej?.error) msg = String(ej.error)
                  } catch {}
                  setPersonLoginError(msg)
                }
              } catch (e) {
                setPersonLoginError('Network error. Please try again.')
              } finally {
                setIsSubmittingLogin(false)
              }
            }}>Continue</button>
          </div>
        </div>
      </div>
    )}
    {tagMenu.open && (
      <div
        className="context-overlay"
        role="menu"
        onClick={() => setTagMenu({ open: false, x: 0, y: 0, tag: null })}
        onContextMenu={(e) => { e.preventDefault(); setTagMenu({ open: false, x: 0, y: 0, tag: null }) }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setTagMenu({ open: false, x: 0, y: 0, tag: null }) } }}
        style={{ position: 'fixed', inset: 0, zIndex: 1000 }}
      >
        <div
          className="context-menu"
          style={{ position: 'absolute', top: tagMenu.y, left: tagMenu.x, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: 4, minWidth: 140 }}
          onClick={(e) => e.stopPropagation()}
        >
          { (activeTags && activeTags.length > 1 && activeTags.some((s) => s.toLowerCase() === String(tagMenu.tag||'').toLowerCase())) ? (
            <button
              className="suggestion-btn"
              style={{ width: '100%', justifyContent: 'flex-start' }}
              onClick={() => {
                const selected = activeTags.slice()
                setTagMenu({ open: false, x: 0, y: 0, tag: null })
                setConfirmDeleteTag(selected)
              }}
            >
              Delete
            </button>
          ) : (
            <>
              <button
                className="suggestion-btn"
                style={{ width: '100%', justifyContent: 'flex-start' }}
                onClick={() => { setRenamingTag(tagMenu.tag); setRenameValue(tagMenu.tag || ''); setTagMenu({ open: false, x: 0, y: 0, tag: null }) }}
              >
                Rename
              </button>
              <button
                className="suggestion-btn"
                style={{ width: '100%', justifyContent: 'flex-start' }}
                onClick={() => {
                  const name = tagMenu.tag
                  setTagMenu({ open: false, x: 0, y: 0, tag: null })
                  if (!name) return
                  setConfirmDeleteTag(name)
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
    )}
    {confirmDeleteTag && (
      <div className="modal-overlay" role="dialog" aria-modal="true" onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); Array.isArray(confirmDeleteTag) ? deleteTags(confirmDeleteTag) : deleteTag(confirmDeleteTag) }
        if (e.key === 'Escape') { e.preventDefault(); setConfirmDeleteTag(null) }
      }}>
        <div className="modal-card">
          <div className="modal-title">{Array.isArray(confirmDeleteTag) ? 'Delete tags' : 'Delete tag'}</div>
          <div className="modal-subtitle">
            {Array.isArray(confirmDeleteTag)
              ? `You are about to delete ${confirmDeleteTag.length} selected tags from all photos. This action cannot be undone.`
              : <>You are about to delete the tag "{confirmDeleteTag}" from all photos. This action cannot be undone.</>}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="suggestion-btn" onClick={() => setConfirmDeleteTag(null)}>Cancel (Esc)</button>
            <button className="suggestion-btn" onClick={() => (Array.isArray(confirmDeleteTag) ? deleteTags(confirmDeleteTag) : deleteTag(confirmDeleteTag))} autoFocus>Delete (Enter)</button>
          </div>
        </div>
      </div>
    )}
    {showShareManager && (
      <div className="modal-overlay share-manager" role="dialog" aria-modal="true" onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); setShowShareManager(false); }
      }}>
        <div className="modal-card">
          <div className="modal-title">Share Links Manager</div>
          <div className="settings-row">
            <label>Create</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input className="settings-input" placeholder="Tag name (case-insensitive)" value={linkTagToCreate} onChange={(e) => setLinkTagToCreate(e.target.value)} />
              <button className="describe-btn" onClick={createShareLink} disabled={!linkTagToCreate.trim() || isCreatingLink}>{isCreatingLink ? 'Creating…' : 'Generate'}</button>
              <button className="describe-btn" onClick={async () => { try { const r = await fetch(`${API_BASE}/share-links/bulk`, { method: 'POST', credentials: 'include' }); if (r.ok) { await refreshShareLinks(); } } catch (e) { console.error(e) } }}>Generate All</button>
            </div>
          </div>
          <div className="settings-row">
            <label>Active Links</label>
            <div style={{ width: '100%' }}>
              {isLoadingShareLinks ? <div>Loading…</div> : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
                  {shareLinks.map((l) => (
                    <li key={l.id} style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, padding: 8 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', overflow: 'hidden' }}>
                        <span style={{ fontWeight: 700 }}>{l.tag_name}</span>
                        <span className="link-url" style={{ color: '#666', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.url}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="describe-btn" onClick={() => { navigator.clipboard?.writeText(l.url).catch(()=>{}) }}>Copy</button>
                        <button className="describe-btn" onClick={() => revokeShareLink(l.id)}>Revoke</button>
                      </div>
                    </li>
                  ))}
                  {shareLinks.length === 0 && <li style={{ color: '#666' }}>No active links</li>}
                </ul>
              )}
            </div>
          </div>
          <div className="settings-actions" style={{ justifyContent: 'flex-end' }}>
            <button className="suggestion-btn" onClick={() => { setShowShareManager(false); }}>Close</button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}

export default App
