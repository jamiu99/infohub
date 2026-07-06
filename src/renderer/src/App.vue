<script setup lang="ts">
import { onMounted } from 'vue'
import { store } from './stores/app'
import SourceList from './components/SourceList.vue'
import ArticleFlow from './components/ArticleFlow.vue'
import ArticleDetail from './components/ArticleDetail.vue'
import UpdateBanner from './components/UpdateBanner.vue'

onMounted(() => void store.init())
</script>

<template>
  <div class="app">
    <aside class="col col-sources"><SourceList /></aside>
    <section class="col col-flow"><ArticleFlow /></section>
    <section class="col col-detail"><ArticleDetail /></section>
    <UpdateBanner />
  </div>
</template>

<style scoped>
.app {
  display: grid;
  grid-template-columns: 248px minmax(320px, 0.9fr) minmax(420px, 1.5fr);
  height: 100vh;
  overflow: hidden;
}
.col {
  height: 100vh;
  overflow-y: auto;
}
.col-sources {
  border-right: 1px solid var(--border);
  background: var(--bg-sidebar);
  display: flex;
  flex-direction: column;
}
.col-flow {
  border-right: 1px solid var(--border);
  background: var(--bg);
}
.col-detail {
  background: var(--bg);
}
</style>
