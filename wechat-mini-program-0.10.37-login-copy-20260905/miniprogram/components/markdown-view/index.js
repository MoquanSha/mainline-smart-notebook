const { parseMarkdown, markdownLinks } = require('../../utils/markdown')
Component({
  properties: {
    nodes: { type: Array, value: [] },
    content: { type: String, value: '', observer(value) { this.setData({ nodes: parseMarkdown(value) }) } }
  },
  data: { links: [] },
  observers: { nodes(nodes) { this.setData({ links: markdownLinks(nodes) }) } },
  methods: {
    copyLink(event) {
      const link = this.data.links[event.currentTarget.dataset.index]
      if (link) wx.setClipboardData({ data: link.url })
    }
  }
})
