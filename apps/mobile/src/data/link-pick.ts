import { create } from 'zustand';

/**
 * 关联字段里「新加一条」（D-546）：关联输入框打开那张表的新记录页（带上自己的 token），
 * 用户存好以后，新记录页把记录 ID 交回来，输入框选上它。只在内存里，不写数据；没存就离开什么都不交。
 */
export const useLinkPick = create<{ picked: { token: string; id: string } | null }>(() => ({
  picked: null,
}));

export const deliverLinkPick = (token: string, id: string) =>
  useLinkPick.setState({ picked: { token, id } });
