/**
 * dsh-os settings panel: the client half of the takeover switch.
 *
 * HOW THIS FILE IS LOADED, AND WHY IT LOOKS LIKE THIS
 *
 * The browser half of a DSH plugin is not an ordinary ES module. It is a self-registering lazy factory
 * keyed by the package name, handed to the page's module table:
 *
 *     window.__ModuleLoader__.load({ id: '<package name>', factory(require) { ... } })
 *
 * React is NOT imported and NOT bundled: it is taken from the module table with `require('react')`, and
 * shipping a second copy would give the page two Reacts and break hooks. `<package.json>` therefore
 * declares `dsh.client` and exposes this file as the `./client` subpath, which is what the loader reads.
 *
 * The file is plain ES5-flavoured JavaScript — no JSX, no TypeScript — deliberately. JSX would require a
 * build step whose output format has to match the table's contract exactly, and a hand-written file in
 * the documented format is verifiable by reading it. `../src/client/` remains the untouched Vite
 * scaffold it always was; this is the artifact that ships.
 *
 * WHAT THE PANEL DOES
 *
 * It edits three things and shows one:
 *
 *   * the master switch, which is the only control that turns interception on;
 *   * a per-tool switch for each of read / write / edit / pwsh;
 *   * the write convention (preserve the target's BOM and line endings, or reproduce the built-in
 *     UTF-8-without-BOM, LF behaviour);
 *   * an activity feed of what was actually taken over, which is the only view that can distinguish
 *     "configured" from "working".
 *
 * State lives on the host (see `settings.js`), reached over the same-origin endpoints
 * `/api/dsh-os/settings` and `/api/dsh-os/set`. The panel is a pure view over that state, so a page
 * reload costs nothing and two open windows cannot disagree.
 */

window.__ModuleLoader__.load({
  id: 'deepseek-coordination',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Endpoints registered by the host half. Relative, so no port or origin is baked in. */
    const STATE_URL = '/api/dsh-os/settings'
    const SET_URL = '/api/dsh-os/set'

    /**
     * Theme tokens only.
     *
     * Literal colours would be wrong in one of the two themes, and reaching into another plugin's
     * stylesheet is forbidden by the UI rules. A renamed token degrades the appearance; it never
     * breaks rendering, which is the property being bought here.
     */
    const T = {
      label: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      labelTertiary: 'var(--dsw-alias-label-tertiary)',
      border: '1px solid var(--dsw-alias-border-l)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      module: 'var(--dsw-alias-bg-module-platform)',
    }

    /** One labelled row with a switch on the right, matching the host's settings row rhythm. */
    function Switch(props) {
      const { checked, disabled, onChange, label, hint } = props
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          gap: '12px',
          padding: '10px 0',
          borderBottom: T.border,
        },
      }, [
        h('div', { key: 'text', style: { flex: '1 1 auto', minWidth: 0 } }, [
          h('div', { key: 'label', style: { color: T.label, fontSize: '13px', lineHeight: '20px' } }, label),
          hint === undefined ? null : h('div', {
            key: 'hint',
            style: { color: T.labelTertiary, fontSize: '12px', lineHeight: '18px', marginTop: '2px' },
          }, hint),
        ]),
        h('button', {
          key: 'switch',
          type: 'button',
          role: 'switch',
          'aria-checked': checked === true,
          'aria-label': label,
          disabled: disabled === true,
          onClick: () => { if (disabled !== true) onChange(!checked) },
          style: {
            flex: '0 0 auto',
            width: '38px',
            height: '22px',
            borderRadius: '11px',
            border: 'none',
            padding: '0',
            cursor: disabled === true ? 'not-allowed' : 'pointer',
            opacity: disabled === true ? 0.5 : 1,
            background: checked === true ? T.brand : T.hover,
            position: 'relative',
            transition: 'background 120ms linear',
          },
        }, h('span', {
          style: {
            position: 'absolute',
            top: '2px',
            left: checked === true ? '18px' : '2px',
            width: '18px',
            height: '18px',
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 120ms ease',
          },
        })),
      ])
    }

    /** A small segmented control, used for the write convention. */
    function Segmented(props) {
      const { value, options, disabled, onChange } = props
      return h('div', {
        style: { display: 'inline-flex', border: T.border, borderRadius: '6px', overflow: 'hidden' },
      }, options.map((option, index) => h('button', {
        key: option.value,
        type: 'button',
        disabled: disabled === true,
        'aria-pressed': value === option.value,
        onClick: () => { if (disabled !== true) onChange(option.value) },
        style: {
          padding: '4px 10px',
          fontSize: '12px',
          lineHeight: '18px',
          border: 'none',
          borderLeft: index === 0 ? 'none' : T.border,
          cursor: disabled === true ? 'not-allowed' : 'pointer',
          background: value === option.value ? T.brand : 'transparent',
          color: value === option.value ? '#fff' : T.labelSecondary,
        },
      }, option.label)))
    }

    /** Render one activity entry: what was taken over, or why a call fell back. */
    function ActivityRow(props) {
      const entry = props.entry
      const took = entry.outcome === 'taken-over'
      return h('li', {
        style: {
          display: 'flex',
          gap: '8px',
          alignItems: 'baseline',
          padding: '4px 0',
          fontSize: '12px',
          lineHeight: '18px',
        },
      }, [
        h('span', {
          key: 'tool',
          style: {
            flex: '0 0 auto',
            color: took ? T.brand : T.warn,
            fontVariantNumeric: 'tabular-nums',
          },
        }, entry.tool),
        h('span', {
          key: 'subject',
          title: entry.subject,
          style: {
            flex: '1 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: T.labelSecondary,
            direction: 'rtl',
            textAlign: 'left',
          },
        }, entry.subject === '' ? '—' : entry.subject),
        h('span', {
          key: 'outcome',
          style: { flex: '0 0 auto', color: took ? T.labelTertiary : T.error },
        }, took ? '接管' : '回退'),
      ])
    }

    /**
     * The panel.
     *
     * It owns exactly one piece of state (the last document fetched) plus a pending flag. Every control
     * posts and then adopts the response, so the host is always the source of truth and an optimistic
     * local edit cannot drift from what the interception actually reads.
     */
    function SettingsSection() {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(() => {
        fetch(STATE_URL, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((body) => {
            if (body && body.ok) { setState(body); setError(null) } else { setError((body && body.error) || '读取失败') }
          })
          .catch((cause) => setError(String(cause && cause.message ? cause.message : cause)))
      }, [])

      React.useEffect(() => {
        load()
        // The feed is the point of the panel, so it refreshes on a slow interval while it is open. Ten
        // seconds is chosen to be far below the cost of noticing: a five-minute poll would leave a user
        // convinced that nothing is happening.
        const timer = setInterval(load, 10000)
        return () => clearInterval(timer)
      }, [load])

      const save = React.useCallback((patch) => {
        setBusy(true)
        fetch(SET_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then((response) => response.json())
          .then((body) => {
            if (body && body.ok) { setState(body); setError(null) } else { setError((body && body.error) || '保存失败') }
          })
          .catch((cause) => setError(String(cause && cause.message ? cause.message : cause)))
          .then(() => setBusy(false))
      }, [])

      if (state === null) {
        return h('div', { style: { padding: '12px 0', color: error === null ? T.labelTertiary : T.error } },
          error === null ? '正在读取 dsh-os 设置…' : `无法读取 dsh-os 设置：${error}`)
      }

      const settings = state.settings
      const tools = settings.tools || {}
      const activity = settings.activity || []
      const master = settings.enabled === true
      const names = {
        read: '读取文件（read）',
        write: '写入文件（write）',
        edit: '编辑文件（edit）',
        pwsh: '执行命令（pwsh）',
      }
      const hints = {
        read: '经 dsh-os 读取：显式探测编码，剥掉 BOM 后再按行返回。',
        write: '经 dsh-os 写入：保留目标文件原有的 BOM 与换行；新建文件仍按内置约定（UTF-8 无 BOM、LF）。',
        edit: '经 dsh-os 编辑：字面替换语义与内置一致，写回时沿用目标文件的编码约定。',
        pwsh: '经 dsh-os 执行：argv 数组直接传参，不拼 shell 字符串。后台任务与沙箱升级仍走内置实现。',
      }

      return h('div', { style: { padding: '4px 0' } }, [
        h('div', { key: 'head', style: { color: T.labelSecondary, fontSize: '12px', lineHeight: '18px', marginBottom: '4px' } },
          '让 dsh-os 接管内置的文件与命令操作，从而获得字节级编码、BOM 与换行保证。关闭时全部走内置实现。'),

        h(Switch, {
          key: 'master',
          checked: master,
          disabled: busy,
          label: '接管内置操作',
          hint: '总开关。关闭后下面的逐项设置保留，但不再生效。',
          onChange: (next) => save({ enabled: next }),
        }),

        h('div', { key: 'tools', style: { opacity: master ? 1 : 0.55 } },
          ['read', 'write', 'edit', 'pwsh'].map((tool) => h(Switch, {
            key: tool,
            checked: tools[tool] === true,
            disabled: busy || !master,
            label: names[tool],
            hint: hints[tool],
            onChange: (next) => save({ tools: { [tool]: next } }),
          }))),

        h('div', { key: 'format', style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 0', borderBottom: T.border, opacity: master ? 1 : 0.55 } }, [
          h('div', { key: 'label', style: { flex: '1 1 auto' } }, [
            h('div', { key: 't', style: { color: T.label, fontSize: '13px', lineHeight: '20px' } }, '写入编码约定'),
            h('div', { key: 'h', style: { color: T.labelTertiary, fontSize: '12px', lineHeight: '18px', marginTop: '2px' } },
              '新建文件一律 UTF-8 无 BOM、LF；此项决定改写已有文件时是否沿用其原有约定。'),
          ]),
          h(Segmented, {
            key: 'control',
            value: settings.writeFormat === 'builtin' ? 'builtin' : 'target',
            disabled: busy || !master,
            options: [
              { value: 'target', label: '沿用原文件' },
              { value: 'builtin', label: '同内置' },
            ],
            onChange: (next) => save({ writeFormat: next }),
          }),
        ]),

        h('div', { key: 'activity', style: { paddingTop: '12px' } }, [
          h('div', { key: 'title', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } }, [
            h('span', { key: 't', style: { color: T.label, fontSize: '13px' } }, '最近活动'),
            h('span', { key: 'c', style: { color: T.labelTertiary, fontSize: '12px' } },
              `${activity.length} 条 · ${master ? '接管中' : '未启用'}`),
          ]),
          activity.length === 0
            ? h('div', { key: 'empty', style: { color: T.labelTertiary, fontSize: '12px', padding: '8px 0' } },
              master ? '尚未拦截到调用。' : '启用后这里会显示实际被接管的调用。')
            : h('ul', {
              key: 'list',
              style: { listStyle: 'none', margin: '4px 0 0', padding: '0', maxHeight: '220px', overflowY: 'auto' },
            }, activity.slice().reverse().map((entry, index) => h(ActivityRow, { key: `${entry.at}-${index}`, entry }))),
        ]),

        error === null ? null : h('div', {
          key: 'error',
          style: { marginTop: '10px', color: T.error, fontSize: '12px', lineHeight: '18px' },
        }, error),

        h('div', {
          key: 'path',
          style: { marginTop: '10px', color: T.labelTertiary, fontSize: '11px', lineHeight: '16px', wordBreak: 'break-all' },
        }, `设置文件：${settings.path}`),
      ])
    }

    return {
      // `slots` is the only service the panel needs: it renders into the settings page and talks to the
      // host over plain HTTP, so it does not need the session, the store, or the connection.
      inject: ['slots'],
      apply(ctx) {
        // `inject` waits for the slot to exist; a settings page that is disabled in this profile leaves
        // the panel simply unregistered rather than throwing during activation.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-os',
          order: 140,
          label: () => 'DSH OS',
        }, SettingsSection))
      },
    }
  },
})
