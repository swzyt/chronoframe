import type { User as DBUser } from '../../backend/nodejs/utils/db'

export type SessionUser = Pick<
  DBUser,
  'id' | 'username' | 'email' | 'avatar' | 'isAdmin' | 'isActive'
>

declare module '#auth-utils' {
  interface User extends SessionUser {}
}
