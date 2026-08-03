<script setup lang="ts">
definePageMeta({ layout: false })

const route = useRoute()
const { t } = useI18n()
const password = ref('')
const loading = ref(false)
const errorMessage = ref('')

const submit = async () => {
  loading.value = true
  errorMessage.value = ''
  try {
    await $fetch('/api/access/verify', {
      method: 'POST',
      body: { password: password.value },
    })
    const target =
      typeof route.query.redirect === 'string' &&
      route.query.redirect.startsWith('/')
        ? route.query.redirect
        : '/'
    window.location.assign(target)
  } catch (error: any) {
    errorMessage.value =
      error?.statusCode === 429
        ? t('accessGate.errors.rateLimited')
        : t('accessGate.errors.invalidPassword')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="flex min-h-svh items-center justify-center bg-neutral-950 p-4 text-white">
    <UCard class="w-full max-w-md">
      <div class="space-y-6">
        <div class="space-y-2 text-center">
          <img src="/favicon.svg" alt="ChronoFrame" class="mx-auto size-12" />
          <h1 class="text-2xl font-semibold">{{ $t('accessGate.title') }}</h1>
          <p class="text-sm text-neutral-400">
            {{ $t('accessGate.description') }}
          </p>
        </div>
        <form class="space-y-4" @submit.prevent="submit">
          <UFormField :label="$t('accessGate.passwordLabel')" :error="errorMessage">
            <UInput
              v-model="password"
              type="password"
              autocomplete="current-password"
              autofocus
              class="w-full"
            />
          </UFormField>
          <UButton type="submit" block :loading="loading" :disabled="!password">
            {{ $t('accessGate.unlock') }}
          </UButton>
        </form>
        <div class="text-center">
          <NuxtLink
            :to="{ path: '/signin', query: { redirect: route.query.redirect || '/' } }"
            class="text-sm text-primary hover:underline"
          >
            {{ $t('accessGate.internalLogin') }}
          </NuxtLink>
        </div>
      </div>
    </UCard>
  </main>
</template>
