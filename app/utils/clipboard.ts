const canUseDomClipboard = () =>
  import.meta.client &&
  typeof document !== 'undefined' &&
  typeof navigator !== 'undefined'

const readClipboardText = async () => {
  if (!navigator.clipboard?.readText) return null

  try {
    return await navigator.clipboard.readText()
  } catch {
    return null
  }
}

const verifyClipboardText = async (text: string) => {
  const clipboardText = await readClipboardText()
  return clipboardText === null ? null : clipboardText === text
}

const copyWithSelectionFallback = (text: string) => {
  if (!document.body || typeof document.execCommand !== 'function') {
    return false
  }

  const activeElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  const selection = window.getSelection()
  const selectedRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : []

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.position = 'fixed'
  textarea.style.inset = '0 auto auto 0'
  textarea.style.width = '1px'
  textarea.style.height = '1px'
  textarea.style.padding = '0'
  textarea.style.border = '0'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  textarea.style.fontSize = '16px'
  textarea.style.zIndex = '-1'

  document.body.appendChild(textarea)
  textarea.focus({ preventScroll: true })
  textarea.select()
  textarea.setSelectionRange(0, text.length)

  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)

    selection?.removeAllRanges()
    for (const range of selectedRanges) {
      selection?.addRange(range)
    }

    activeElement?.focus({ preventScroll: true })
  }
}

export const copyTextToClipboard = async (text: string) => {
  if (!text || !canUseDomClipboard()) return false

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      const verified = await verifyClipboardText(text)
      if (verified === true) return true
      if (verified === null && copyWithSelectionFallback(text)) return true
      if (verified === false && copyWithSelectionFallback(text)) {
        return (await verifyClipboardText(text)) !== false
      }
    }
  } catch {
    // Fall back to a temporary textarea below. Clipboard API can fail on
    // non-secure origins, missing focus, or after user activation expires.
  }

  const copied = copyWithSelectionFallback(text)
  if (!copied) return false

  const verified = await verifyClipboardText(text)
  return verified !== false
}
