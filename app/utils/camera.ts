/**
 * 处理相机品牌和型号的显示，避免品牌名称重复
 */
const stringifyExifValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return value.map(stringifyExifValue).filter(Boolean).join(' ')
  }
  return ''
}

export function formatCameraInfo(make?: unknown, model?: unknown): string {
  const makeText = stringifyExifValue(make)
  const modelText = stringifyExifValue(model)

  if (!makeText && !modelText) return ''
  if (!makeText) return modelText
  if (!modelText) return makeText

  // 常见品牌名称映射（包括各种可能的变体）
  const brandMap: Record<string, string[]> = {
    Canon: ['canon', 'eos'],
    Nikon: ['nikon'],
    Sony: ['sony', 'ilce', 'dsc'],
    Fujifilm: ['fujifilm', 'fuji', 'x-'],
    Olympus: ['olympus', 'om-', 'e-'],
    Panasonic: ['panasonic', 'lumix', 'dc-', 'dmc-'],
    Leica: ['leica'],
    Pentax: ['pentax', 'k-'],
    Ricoh: ['ricoh', 'gr'],
    Hasselblad: ['hasselblad'],
    'Phase One': ['phase one'],
    Mamiya: ['mamiya'],
    Apple: ['apple'],
    Samsung: ['samsung', 'galaxy', 'sm-'],
    Google: ['pixel'],
    Xiaomi: ['xiaomi', 'mi ', 'redmi'],
    Huawei: ['huawei', 'p30', 'p40', 'p50', 'mate'],
    OnePlus: ['oneplus'],
    OPPO: ['oppo'],
    Vivo: ['vivo'],
    Realme: ['realme'],
    Honor: ['honor'],
  }

  const makeNormalized = makeText.toLowerCase().trim()
  const modelNormalized = modelText.toLowerCase().trim()

  // 检查型号中是否已经包含品牌信息
  const brandKeywords = brandMap[makeText] || [makeNormalized]
  const modelContainsBrand = brandKeywords.some((keyword) =>
    modelNormalized.includes(keyword.toLowerCase()),
  )

  if (modelContainsBrand) {
    // 如果型号已包含品牌信息，只返回型号
    return modelText
  } else {
    // 如果型号不包含品牌信息，返回品牌+型号
    return `${makeText} ${modelText}`
  }
}

/**
 * 格式化镜头信息，处理品牌和型号
 */
export function formatLensInfo(
  lensMake?: unknown,
  lensModel?: unknown,
): string {
  const lensMakeText = stringifyExifValue(lensMake)
  const lensModelText = stringifyExifValue(lensModel)

  if (!lensMakeText && !lensModelText) return ''
  if (!lensMakeText) return lensModelText
  if (!lensModelText) return lensMakeText

  // 镜头品牌映射
  const lensBrandMap: Record<string, string[]> = {
    Canon: ['canon', 'ef', 'rf'],
    Nikon: ['nikon', 'nikkor'],
    Sony: ['sony', 'fe', 'e '],
    Sigma: ['sigma'],
    Tamron: ['tamron'],
    Tokina: ['tokina'],
    Samyang: ['samyang'],
    Zeiss: ['zeiss'],
    Voigtländer: ['voigtlander', 'voigtländer'],
    Leica: ['leica'],
    Panasonic: ['panasonic', 'lumix'],
    Olympus: ['olympus', 'zuiko'],
    Fujifilm: ['fujifilm', 'fujinon', 'xf', 'xc'],
  }

  const lensMakeNormalized = lensMakeText.toLowerCase().trim()
  const lensModelNormalized = lensModelText.toLowerCase().trim()

  // 检查镜头型号中是否已经包含品牌信息
  const brandKeywords = lensBrandMap[lensMakeText] || [lensMakeNormalized]
  const modelContainsBrand = brandKeywords.some((keyword) =>
    lensModelNormalized.includes(keyword.toLowerCase()),
  )

  if (modelContainsBrand) {
    return lensModelText
  } else {
    return `${lensMakeText} ${lensModelText}`
  }
}
