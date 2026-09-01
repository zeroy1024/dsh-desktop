import type { VisionCardProps } from './types.ts'
import { CheckboxField, SecretField, SelectField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'

const protocolOptions = [
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'anthropic', label: 'Anthropic Messages' },
]

export function VisionCard(props: VisionCardProps) {
  const state = props.useVisionCard(snapshot => snapshot)
  const disabled = !state.writable
  const t = props.t
  return (
    <PluginCard t={t} state={state} onSave={props.save} onDiscard={props.discard}>
      <CheckboxField
        id="plugin-config-vision-enabled"
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
        id="plugin-config-vision-protocol"
        label={t('protocol')}
        hint={t('protocolHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        disabled={disabled}
        options={protocolOptions}
        {...state.protocol}
        onEdit={text => { props.edit('protocol', text) }}
        onReset={() => { props.resetField('protocol') }}
      />
      <ValueField
        id="plugin-config-vision-endpoint"
        label={t('endpoint')}
        hint={t('endpointHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        disabled={disabled}
        placeholder="https://api.example.com/v1"
        {...state.baseURL}
        onEdit={text => { props.edit('baseURL', text) }}
        onReset={() => { props.resetField('baseURL') }}
      />
      <ValueField
        id="plugin-config-vision-model"
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
      <SecretField
        id="plugin-config-vision-key"
        label={t('apiKey')}
        hint={t('apiKeyHint')}
        text={state.apiKey.text}
        configured={state.apiKeyConfigured}
        configuredLabel={t('configured')}
        notConfiguredLabel={t('notConfigured')}
        disabled={disabled || !state.apiKeyWritable}
        onEdit={text => { props.edit('apiKey', text) }}
      />
      <SelectField
        id="plugin-config-vision-unknown-capability-policy"
        label={t('unknownCapabilityPolicy')}
        hint={t('unknownCapabilityPolicyHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        disabled={disabled}
        options={[
          { value: 'passthrough', label: t('unknownCapabilityPolicyPassthrough') },
          { value: 'bridge', label: t('unknownCapabilityPolicyBridge') },
        ]}
        {...state.unknownCapabilityPolicy}
        onEdit={text => { props.edit('unknownCapabilityPolicy', text) }}
        onReset={() => { props.resetField('unknownCapabilityPolicy') }}
      />
      <ValueField
        id="plugin-config-vision-prompt"
        label={t('prompt')}
        hint={t('promptHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        disabled={disabled}
        {...state.prompt}
        onEdit={text => { props.edit('prompt', text) }}
        onReset={() => { props.resetField('prompt') }}
      />
      <ValueField
        id="plugin-config-vision-reasoning"
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
      <ValueField
        id="plugin-config-vision-timeout"
        label={t('timeout')}
        hint={t('timeoutHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        numeric
        disabled={disabled}
        {...state.requestTimeoutMs}
        onEdit={text => { props.edit('requestTimeoutMs', text) }}
        onReset={() => { props.resetField('requestTimeoutMs') }}
      />
      <ValueField
        id="plugin-config-vision-max-tokens"
        label={t('maxTokens')}
        hint={t('maxTokensHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        numeric
        disabled={disabled}
        {...state.describeMaxTokens}
        onEdit={text => { props.edit('describeMaxTokens', text) }}
        onReset={() => { props.resetField('describeMaxTokens') }}
      />
      <CheckboxField
        id="plugin-config-vision-focus"
        label={t('focusHint')}
        hint={t('focusHintHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        disabled={disabled}
        {...state.focusHint}
        onEdit={text => { props.edit('focusHint', text) }}
        onReset={() => { props.resetField('focusHint') }}
      />
      <ValueField
        id="plugin-config-vision-cache-size"
        label={t('cacheSize')}
        hint={t('cacheSizeHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        numeric
        disabled={disabled}
        {...state.cacheSize}
        onEdit={text => { props.edit('cacheSize', text) }}
        onReset={() => { props.resetField('cacheSize') }}
      />
      <ValueField
        id="plugin-config-vision-max-evidence"
        label={t('maxEvidenceChars')}
        hint={t('maxEvidenceCharsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        numeric
        disabled={disabled}
        {...state.maxEvidenceChars}
        onEdit={text => { props.edit('maxEvidenceChars', text) }}
        onReset={() => { props.resetField('maxEvidenceChars') }}
      />
      <ValueField
        id="plugin-config-vision-max-image-bytes"
        label={t('maxImageBytes')}
        hint={t('maxImageBytesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        numeric
        disabled={disabled}
        {...state.maxImageBytes}
        onEdit={text => { props.edit('maxImageBytes', text) }}
        onReset={() => { props.resetField('maxImageBytes') }}
      />
    </PluginCard>
  )
}
