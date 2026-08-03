import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'ChronoFrame',
  description: '自部署、在线管理的个人画廊',
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: '指南', link: '/zh/guide/getting-started' },
      { text: 'Wiki', link: '/zh/wiki/overview' },
      { text: '开发文档', link: '/zh/development/contributing' },
      { text: '演示', link: 'https://lens.bh8.ga' },
    ],

    sidebar: [
      {
        text: '指南',
        items: [
          { text: '快速开始', link: '/zh/guide/getting-started' },
          { text: '配置说明', link: '/zh/guide/configuration' },
          {
            text: 'Docker 镜像发布',
            link: '/zh/guide/docker-image-publish',
          },
          { text: '升级指南', link: '/zh/guide/updates' },
          {
            text: '与上游仓库的差异',
            link: '/zh/guide/fork-differences',
          },
        ],
      },
      {
        text: 'Wiki',
        items: [
          { text: '总览', link: '/zh/wiki/overview' },
          { text: '部署与升级', link: '/zh/wiki/deployment' },
          { text: '管理员手册', link: '/zh/wiki/admin-guide' },
          { text: '访客与普通用户手册', link: '/zh/wiki/user-guide' },
          { text: '媒体、存储与地图', link: '/zh/wiki/media-storage-map' },
          { text: '运维、备份与排障', link: '/zh/wiki/operations' },
          { text: '开发者参考', link: '/zh/wiki/development' },
        ],
      },
      {
        text: '配置',
        items: [
          { text: '存储提供器', link: '/zh/configuration/storage-providers' },
          { text: '地图提供器', link: '/zh/configuration/map-providers' },
          { text: '位置提供器', link: '/zh/configuration/location-providers' },
        ],
      },
      {
        text: '开发',
        items: [
          { text: '贡献指南', link: '/zh/development/contributing' },
          { text: 'API 文档', link: '/zh/development/api' },
        ],
      },
    ],

    editLink: {
      text: '在 GitHub 上编辑此页面',
    },
  },
})
