import { defineConfig } from 'vitepress'

// apple-pi docs site config.
// Served at https://jotokra.github.io/apple-pi/guide/ — `base` is the
// GitHub-Pages repo-prefix + the subpath (landing stays at /apple-pi/).
// The hand-crafted marketing landing (docs/index.html) is the site root;
// this guide is the navigable reference at /guide/.
export default defineConfig({
  title: 'apple-pi',
  description: 'A self-tuning, privacy-first coding agent you own.',
  base: '/apple-pi/guide/',
  cleanUrls: true,
  lastUpdated: true,

  head: [
    // Warm accent for the docs to echo the landing's apple palette.
    ['meta', { name: 'theme-color', content: '#160f0c' }]
  ],

  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' }
  },

  themeConfig: {
    siteTitle: 'apple-pi 🥧',

    nav: [
      { text: 'Home', link: 'https://jotokra.github.io/apple-pi/' },
      { text: 'GitHub', link: 'https://github.com/jotokra/apple-pi' },
      { text: 'Install', link: '/install' }
    ],

    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Why apple-pi', link: '/why' },
          { text: 'Install', link: '/install' },
          { text: 'Using apple-pi', link: '/usage' }
        ]
      },
      {
        text: 'Guides',
        items: [
          { text: 'How-to guides', link: '/howto' }
        ]
      },
      {
        text: 'Reference',
        collapsed: false,
        items: [
          { text: 'Commands', link: '/commands' },
          { text: 'Skills', link: '/skills' },
          { text: 'README (full)', link: 'https://github.com/jotokra/apple-pi#readme' }
        ]
      }
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/jotokra/apple-pi' }],

    search: { provider: 'local', options: { translations: { button: { buttonText: 'Search docs', buttonAriaLabel: 'Search' } } } },

    outline: { level: [2, 3], label: 'On this page' },

    docFooter: { prev: 'Previous', next: 'Next' },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'apple-pi is a pie, not a product. Not affiliated with Apple Inc.'
    },

    darkModeSwitchLabel: 'theme',
    sidebarMenuLabel: 'menu',
    returnToTopLabel: 'back to top'
  }
})
