import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { DialogHost } from '../../src/client/dialogs.js'
import { NotificationHost } from '../../src/client/notification.js'
import { installNativeDialogTakeover } from '../../src/client/nativeDialogs.js'
import { useAmpPreferences } from '../../src/client/preferences.js'
import { setLocale } from '../../src/client/i18n.js'
setLocale('zh')
const h = React.createElement
const root = createRoot(document.getElementById('app')!)
function App() {
  const { set } = useAmpPreferences()
  ;(window as any).setTakeover = (enabled: boolean) => set('takeoverNotifications', enabled)
  return h(React.Fragment, null, h(DialogHost, { sessionId: 'test-session' }), h(NotificationHost, { sessionId: 'test-session' }))
}
installNativeDialogTakeover()
root.render(h(App))

function ControlledNative() {
  const [text, setText] = React.useState('')
  const [checked, setChecked] = React.useState(false)
  const [visible, setVisible] = React.useState(true)
  return !visible ? null : h('div', { role: 'presentation', id: 'controlled-host' },
    h('div', { 'aria-hidden': true }),
    h('div', { role: 'dialog', 'aria-modal': true, 'aria-label': 'Controlled host input' },
      h('div', null,
        h('h2', null, 'Controlled host input'),
        h('input', { 'aria-label': 'Controlled text', value: text, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setText(event.target.value) }),
        h('input', { type: 'checkbox', 'aria-label': 'Acknowledge', checked, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setChecked(event.target.checked) }),
      ),
      h('div', null,
        h('button', { onClick: () => setVisible(false) }, 'Cancel'),
        h('button', { disabled: !checked || !text, onClick: () => { (window as any).controlledResult = text; setVisible(false) } }, 'Submit input'),
      ),
    ),
  )
}
;(window as any).openControlledNative = () => {
  const container = document.createElement('div')
  document.body.append(container)
  createRoot(container).render(h(ControlledNative))
}
