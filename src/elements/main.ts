/**
 * Entry point of the Angular Elements bundle.
 *
 * The DSH client half loads this file as a module from the plugin's host route
 * and then renders `<dsh-coordination-controls>` inside its slot content. The
 * element is registered once per page: a second definition of the same tag
 * throws, and the host may re-run a plugin's client half on HMR.
 */
import { provideZonelessChangeDetection } from '@angular/core'
import { createApplication } from '@angular/platform-browser'
import { createCustomElement } from '@angular/elements'

import { CoordinationControlsComponent } from './controls.component'

/** Tag name the host renders. */
export const ELEMENT_TAG = 'dsh-coordination-controls'

/**
 * Boot the Angular application and define the custom element.
 *
 * Zoneless change detection is deliberate: the host runs its own React renderer
 * and must not have zone.js patching globals underneath it.
 */
createApplication({ providers: [provideZonelessChangeDetection()] })
    .then((app) => {
        if (customElements.get(ELEMENT_TAG) === undefined) {
            const element = createCustomElement(CoordinationControlsComponent, { injector: app.injector })
            customElements.define(ELEMENT_TAG, element)
        }
        window.dispatchEvent(new CustomEvent('dsh-coordination:ready', { detail: { tag: ELEMENT_TAG } }))
    })
    .catch((error: unknown) => {
        // Fail visible: a silent rejection here looks exactly like "the plugin did nothing".
        window.dispatchEvent(new CustomEvent('dsh-coordination:error', { detail: { error: String(error) } }))
    })
