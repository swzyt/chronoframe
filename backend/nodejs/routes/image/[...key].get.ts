import { eventHandler } from 'h3'
import { handleImageMediaRequest } from '#server/utils/media-route-handlers'

export default eventHandler(handleImageMediaRequest)
