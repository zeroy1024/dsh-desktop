import type { SettingsCardProps } from './types.ts'
import type { WebSearchCardState } from './controller.ts'
import { CheckboxField, SecretField, SelectField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'

type Props = SettingsCardProps<WebSearchCardState> & {
  useWebSearchCard: SettingsCardProps<WebSearchCardState>['useCard']
}

/** Browser-side visual configuration card for the provider-only host plugin. */
export function WebSearchCard(props: Props) {
  const state = props.useWebSearchCard(snapshot => snapshot)
  const t = props.t
  const disabled = !state.writable
  const isAnthropic = state.protocol.text === 'anthropic'

  return (
    <PluginCard
      t={t}
      title={t('title')}
      description={t('description')}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <CheckboxField
        id="plugin-config-web-search-enabled"
        label={t('enabled')}
        hint={t('enabledHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        disabled={disabled}
        {...state.enabled}
        onEdit={text => { props.edit('enabled', text) }}
        onReset={() => { props.resetField('enabled') }}
      />
      <SelectField
        id="plugin-config-web-search-protocol"
        label={t('protocol')}
        hint={t('protocolHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        disabled={disabled}
        options={[
          { value: 'openai-responses', label: t('responsesProtocol') },
          { value: 'anthropic', label: t('anthropicProtocol') },
        ]}
        {...state.protocol}
        onEdit={text => { props.edit('protocol', text) }}
        onReset={() => { props.resetField('protocol') }}
      />
      <ValueField
        id="plugin-config-web-search-endpoint"
        label={t('baseURL')}
        hint={t('baseURLHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        disabled={disabled}
        {...state.baseURL}
        onEdit={text => { props.edit('baseURL', text) }}
        onReset={() => { props.resetField('baseURL') }}
      />
      <SecretField
        id="plugin-config-web-search-key"
        label={t('apiKey')}
        hint={t('apiKeyHint')}
        text={state.apiKey.text}
        configured={state.apiKeyConfigured}
        stateLabel={t(state.apiKeyConfigured ? 'apiKeySet' : 'apiKeyUnset')}
        disabled={!state.apiKeyWritable}
        onEdit={text => { props.edit('apiKey', text) }}
      />
      <ValueField
        id="plugin-config-web-search-model"
        label={t('model')}
        hint={t('modelHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        disabled={disabled}
        {...state.model}
        onEdit={text => { props.edit('model', text) }}
        onReset={() => { props.resetField('model') }}
      />
      {!isAnthropic
        ? <ValueField
          id="plugin-config-web-search-reasoning-effort"
          label={t('reasoningEffort')}
          hint={t('reasoningEffortHint')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalid')}
          disabled={disabled}
          {...state.reasoningEffort}
          onEdit={text => { props.edit('reasoningEffort', text) }}
          onReset={() => { props.resetField('reasoningEffort') }}
        />
        : null}
      <ValueField
        id="plugin-config-web-search-timeout"
        label={t('requestTimeoutMs')}
        hint={t('requestTimeoutMsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.requestTimeoutMs}
        onEdit={text => { props.edit('requestTimeoutMs', text) }}
        onReset={() => { props.resetField('requestTimeoutMs') }}
      />
      {isAnthropic
        ? <>
          <ValueField
            id="plugin-config-web-search-anthropic-version"
            label={t('anthropicApiVersion')}
            hint={t('anthropicApiVersionHint')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalid')}
            disabled={disabled}
            {...state.anthropicApiVersion}
            onEdit={text => { props.edit('anthropicApiVersion', text) }}
            onReset={() => { props.resetField('anthropicApiVersion') }}
          />
          <ValueField
            id="plugin-config-web-search-anthropic-tokens"
            label={t('anthropicMaxTokens')}
            hint={t('anthropicMaxTokensHint')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalidNumber')}
            numeric
            disabled={disabled}
            {...state.anthropicMaxTokens}
            onEdit={text => { props.edit('anthropicMaxTokens', text) }}
            onReset={() => { props.resetField('anthropicMaxTokens') }}
          />
          <ValueField
            id="plugin-config-web-search-anthropic-uses"
            label={t('anthropicMaxUses')}
            hint={t('anthropicMaxUsesHint')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalidNumber')}
            numeric
            disabled={disabled}
            {...state.anthropicMaxUses}
            onEdit={text => { props.edit('anthropicMaxUses', text) }}
            onReset={() => { props.resetField('anthropicMaxUses') }}
          />
        </>
        : null}
    </PluginCard>
  )
}
