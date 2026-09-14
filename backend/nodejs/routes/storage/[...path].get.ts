import { eventHandler } from 'h3'
import { handleStorageMediaRequest } from '#server/utils/media-route-handlers'

export default eventHandler(handleStorageMediaRequest)
