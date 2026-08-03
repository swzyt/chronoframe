import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'ChronoFrame',
  description: 'A Self-hosted photo gallery',
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    [
      'script',
      {
        async: '',
        src: 'https://www.googletagmanager.com/gtag/js?id=G-RQSZM9PP5F',
      },
    ],
    [
      'script',
      {},
      `window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', 'G-RQSZM9PP5F');`,
    ],
    [
      'script',
      {
        async: '',
        src: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7236608137732943',
        crossorigin: 'anonymous',
      },
    ],
  ],
  lastUpdated: true,
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Wiki', link: '/wiki/overview' },
      { text: 'Development', link: '/development/contributing' },
      { text: 'Demo', link: 'https://lens.bh8.ga' },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Configuration', link: '/guide/configuration' },
          {
            text: 'Docker Image Publishing',
            link: '/guide/docker-image-publish',
          },
          { text: 'Update Guide', link: '/guide/updates' },
          {
            text: 'Differences from Upstream',
            link: '/guide/fork-differences',
          },
        ],
      },
      {
        text: 'Wiki',
        items: [
          { text: 'Overview', link: '/wiki/overview' },
          { text: 'Deployment and Upgrades', link: '/wiki/deployment' },
          { text: 'Admin Guide', link: '/wiki/admin-guide' },
          { text: 'Visitor and User Guide', link: '/wiki/user-guide' },
          {
            text: 'Media, Storage, and Maps',
            link: '/wiki/media-storage-map',
          },
          {
            text: 'Operations and Troubleshooting',
            link: '/wiki/operations',
          },
          { text: 'Developer Reference', link: '/wiki/development' },
        ],
      },
      {
        text: 'Configuration',
        items: [
          {
            text: 'Storage Providers',
            link: '/configuration/storage-providers',
          },
          { text: 'Map Providers', link: '/configuration/map-providers' },
          {
            text: 'Location Providers',
            link: '/configuration/location-providers',
          },
        ],
      },
      {
        text: 'Development',
        items: [
          { text: 'Contributing Guide', link: '/development/contributing' },
          { text: 'API Documentation', link: '/development/api' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/swzyt/chronoframe' },
      { icon: 'discord', link: 'https://discord.gg/MM4ZK4Ed7s' },
    ],

    editLink: {
      pattern: 'https://github.com/swzyt/chronoframe/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2025 Timothy Yin',
    },
  },
  locales: {
    root: {
      label: 'English',
      lang: 'en',
    },
    zh: {
      label: '简体中文',
      lang: 'zh',
      link: '/zh/',
      themeConfig: {
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
              {
                text: '媒体、存储与地图',
                link: '/zh/wiki/media-storage-map',
              },
              { text: '运维、备份与排障', link: '/zh/wiki/operations' },
              { text: '开发者参考', link: '/zh/wiki/development' },
            ],
          },
          {
            text: '配置',
            items: [
              {
                text: '存储提供器',
                link: '/zh/configuration/storage-providers',
              },
              { text: '地图提供器', link: '/zh/configuration/map-providers' },
              {
                text: '位置提供器',
                link: '/zh/configuration/location-providers',
              },
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
          pattern: 'https://github.com/swzyt/chronoframe/edit/main/docs/:path',
          text: '在 GitHub 上编辑此页面',
        },
      },
    },
  },

  ignoreDeadLinks: [/^http?:\/\/localhost/],
})
