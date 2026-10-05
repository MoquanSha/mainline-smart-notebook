Page({
  redirected: false,
  onLoad() {
    this.redirectToCurrentPage()
  },
  onShow() {
    this.redirectToCurrentPage()
  },
  redirectToCurrentPage() {
    if (this.redirected) return
    this.redirected = true
    wx.reLaunch({ url: '/pages/home/index' })
  }
})
