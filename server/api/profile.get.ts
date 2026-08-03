export default eventHandler(async (event) => {
  const { password: _password, ...user } = await requireCurrentUser(event)
  return user
})
