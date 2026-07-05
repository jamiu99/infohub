<script setup lang="ts">
import { onMounted } from 'vue'
import { store } from './stores/app'
import SourceList from './components/SourceList.vue'
import ArticleFlow from './components/ArticleFlow.vue'
import ArticleDetail from './components/ArticleDetail.vue'

onMounted(() => void store.init())
</script>

<template>
  <div class="app">
    <aside class="col col-sources"><SourceList /></aside>
    <section class="col col-flow"><ArticleFlow /></section>
    <section class="col col-detail"><ArticleDetail /></section>
  </div>
</template>

<style scoped>
.app {
  display: grid;
  grid-template-columns: 260px minmax(300px, 1fr) minmax(360px, 1.4fr);
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
}
</style>
