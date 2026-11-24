// True snapshot of schemaVersion 4 (fixed data slot period D-014), used as migration regression
// test (§7E). Do not modify: they represent historical versions already present on user devices.

const theme = {
  primaryColor: '#C8623A',
  mode: 'light',
  colors: {},
  font: 'clay',
  fontScale: 1,
  radius: 22,
  density: 'comfortable',
  cardStyle: 'shadow',
  navStyle: 'iconLabel',
};

const base = (steps: unknown[]) => ({
  schemaVersion: 4,
  theme,
  shell: { nav: ['page:home', 'tools', 'ai', 'history', 'settings'], floating: [] },
  pages: [
    {
      id: 'home',
      title: '首页',
      icon: 'home',
      components: [
        { id: 'welcome', type: 'header', props: { title: '我的工作台' } },
        { id: 'card-pdf', type: 'toolCard', props: { toolId: 'pdf' } },
        { id: 'catalog', type: 'catalogLink', props: { title: '添加工具' } },
        { id: 'recent-files', type: 'fileList', props: { title: '最近文件', limit: 5 } },
      ],
    },
    {
      id: 'tool-pdf',
      title: 'PDF',
      icon: 'document',
      toolId: 'pdf',
      components: [
        { id: 'pdf-header', type: 'header', props: { title: '合并 PDF' } },
        { id: 'pdf-runner', type: 'workflowRunner', props: { workflowId: 'pdf-merge' } },
        {
          id: 'pdf-files',
          type: 'fileList',
          props: { title: 'PDF 文件', limit: 10, mimeType: 'application/pdf' },
        },
      ],
    },
  ],
  tools: [{ toolId: 'pdf', version: '1.0.0', pageId: 'tool-pdf' }],
  workflows: [{ id: 'pdf-merge', toolId: 'pdf', name: '合并 PDF', steps }],
  collections: [],
});

/** Default flow after installing PDF: pick file → merge → enter file name → save. */
export const V4_DEFAULT_MERGE = base([
  { id: 'select', action: 'pdf.selectFiles', params: { min: 2, max: 20 } },
  { id: 'merge', action: 'pdf.merge', params: {} },
  { id: 'name', action: 'ui.askFileName', params: { defaultTemplate: '{sourceName}-合并' } },
  { id: 'save', action: 'file.save', params: { nameTemplate: '{sourceName}-合并' } },
]);

/** "Name by date on completion without asking": removes prompt, uses fixed template on save. */
export const V4_FIXED_NAME = base([
  { id: 'select', action: 'pdf.selectFiles', params: { min: 2, max: 20 } },
  { id: 'merge', action: 'pdf.merge', params: {} },
  { id: 'save', action: 'file.save', params: { nameTemplate: '合并-{date:YYYY-MM-DD}' } },
]);

/** Default name and save template when parameters are modified and prompting. */
export const V4_CUSTOM_ASK = base([
  { id: 'select', action: 'pdf.selectFiles', params: { min: 3, max: 5 } },
  { id: 'merge', action: 'pdf.merge', params: {} },
  { id: 'name', action: 'ui.askFileName', params: { defaultTemplate: '材料-{date:YYYYMMDD}' } },
  { id: 'save', action: 'file.save', params: { nameTemplate: '{sourceName}-合并' } },
]);
