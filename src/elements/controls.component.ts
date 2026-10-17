/**
 * Coordination controls — the Angular custom element the DSH host mounts.
 *
 * Two regions of the host composer are addressed, matching the annotated mock:
 *  - the blue region (the resident access-mode dropdown) is hidden by the host
 *    half's CSS takeover; when `takeover` is on, this element renders the
 *    replacement dropdown in its place;
 *  - the green region is the free space right of that control, where the three
 *    selectors render left to right: 职能 → 交互 → 情景.
 *
 * Everything here is presentation: the element reports every change through the
 * `selectionchange` CustomEvent and never talks to the host itself.
 */
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core'

/** 职能 — the duty dimension of the role framework. */
export const DUTY_OPTIONS = ['决策', '成果', '资源', '人员', '任职', '执行'] as const

/** 交互 — the interaction mode. */
export const INTERACTION_OPTIONS = ['感情', '思维', '启发', '收束'] as const

/** 情景 — the working scenario. */
export const SCENARIO_OPTIONS = ['对话', '写作', '办公', '研究', '工程', '迭代'] as const

/**
 * Fallback options for the replacement dropdown. The host owns the real preset
 * list; it is passed in through the `permissions` attribute as JSON when known,
 * and this list is only what the element can fall back to.
 */
export const PERMISSION_FALLBACK = ['完全权限'] as const

/** One option of the replacement dropdown. */
export interface PermissionOption {
    /** Machine value handed to the host (for example `danger-full-access`). */
    value: string
    /** User-facing label. */
    label: string
}

/** Payload of the `selectionchange` event. */
export interface CoordinationSelection {
    duty: string
    interaction: string
    scenario: string
    permission: string
}

@Component({
    selector: 'dsh-coordination-controls',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="row">
            @if (takeover()) {
                <label class="field">
                    <span class="material-symbols-outlined" aria-hidden="true">shield_person</span>
                    <select
                        class="select"
                        aria-label="权限接管"
                        [value]="permission()"
                        (change)="onPermission($any($event.target).value)"
                    >
                        @for (option of permissionOptions(); track option.value) {
                            <option [value]="option.value">{{ option.label }}</option>
                        }
                    </select>
                </label>
            }

            <label class="field">
                <span class="material-symbols-outlined" aria-hidden="true">account_tree</span>
                <select class="select" aria-label="职能" [value]="duty()" (change)="onDuty($any($event.target).value)">
                    @for (option of duties; track option) {
                        <option [value]="option">{{ option }}</option>
                    }
                </select>
            </label>

            <label class="field">
                <span class="material-symbols-outlined" aria-hidden="true">forum</span>
                <select
                    class="select"
                    aria-label="交互"
                    [value]="interaction()"
                    (change)="onInteraction($any($event.target).value)"
                >
                    @for (option of interactions; track option) {
                        <option [value]="option">{{ option }}</option>
                    }
                </select>
            </label>

            <label class="field">
                <span class="material-symbols-outlined" aria-hidden="true">category</span>
                <select
                    class="select"
                    aria-label="情景"
                    [value]="scenario()"
                    (change)="onScenario($any($event.target).value)"
                >
                    @for (option of scenarios; track option) {
                        <option [value]="option">{{ option }}</option>
                    }
                </select>
            </label>
        </div>
    `,
    styles: `
        :host {
            display: inline-flex;
            align-items: center;
            min-width: 0;
            font: inherit;
        }
        .row {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
        }
        .field {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            min-width: 0;
            color: var(--dsw-alias-label-secondary, #666);
        }
        .select {
            font: inherit;
            font-size: 12px;
            line-height: 20px;
            height: 24px;
            padding: 0 4px;
            border: 1px solid var(--dsw-alias-border-secondary, #d0d0d0);
            border-radius: 6px;
            background: var(--dsw-alias-bg-primary, transparent);
            color: var(--dsw-alias-label-primary, inherit);
            cursor: pointer;
            max-width: 96px;
        }
        .select:focus-visible {
            outline: 2px solid var(--dsw-alias-brand-primary, #4f8cff);
            outline-offset: 1px;
        }
        .material-symbols-outlined {
            font-size: 16px;
            line-height: 1;
        }
    `,
})
export class CoordinationControlsComponent {
    /** Whether the host access-mode control is hidden and the replacement is shown. */
    readonly takeover = input(false, { transform: (value: boolean | string) => value === true || value === 'on' })

    /** Permission options as JSON, e.g. `[{"value":"danger-full-access","label":"完全权限"}]`. */
    readonly permissions = input('')

    /** Emitted for every selection change. */
    readonly selectionchange = output<CoordinationSelection>()

    readonly duties = DUTY_OPTIONS
    readonly interactions = INTERACTION_OPTIONS
    readonly scenarios = SCENARIO_OPTIONS

    readonly duty = signal<string>(DUTY_OPTIONS[0])
    readonly interaction = signal<string>(INTERACTION_OPTIONS[0])
    readonly scenario = signal<string>(SCENARIO_OPTIONS[0])

    /** Parsed replacement-dropdown options, falling back to what the element knows. */
    readonly permissionOptions = computed<PermissionOption[]>(() => {
        const raw = this.permissions()
        if (raw.trim() !== '') {
            try {
                const parsed: unknown = JSON.parse(raw)
                if (Array.isArray(parsed)) {
                    const options = parsed.filter(
                        (item): item is PermissionOption =>
                            typeof item === 'object' &&
                            item !== null &&
                            typeof (item as PermissionOption).value === 'string' &&
                            typeof (item as PermissionOption).label === 'string',
                    )
                    if (options.length > 0) return options
                }
            } catch {
                // A malformed attribute must not break the composer: fall through to the fallback.
            }
        }
        return PERMISSION_FALLBACK.map((label) => ({ value: label, label }))
    })

    /** Currently selected permission value. */
    readonly permission = signal<string>(PERMISSION_FALLBACK[0])

    /** Record a permission change and publish the whole selection. */
    onPermission(value: string): void {
        this.permission.set(value)
        this.emit()
    }

    /** Record a duty change and publish the whole selection. */
    onDuty(value: string): void {
        this.duty.set(value)
        this.emit()
    }

    /** Record an interaction change and publish the whole selection. */
    onInteraction(value: string): void {
        this.interaction.set(value)
        this.emit()
    }

    /** Record a scenario change and publish the whole selection. */
    onScenario(value: string): void {
        this.scenario.set(value)
        this.emit()
    }

    /** Publish the current selection as a bubbling, composed event. */
    private emit(): void {
        this.selectionchange.emit({
            duty: this.duty(),
            interaction: this.interaction(),
            scenario: this.scenario(),
            permission: this.permission(),
        })
    }
}
