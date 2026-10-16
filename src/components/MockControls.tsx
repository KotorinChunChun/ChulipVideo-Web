export type Tone = "plain" | "record" | "start" | "play" | "end" | "save" | "warn";

export function ToolButton({
  children,
  tone = "plain",
  compact = false,
  onClick,
  title,
  className = "",
  disabled = false,
}: {
  children: React.ReactNode;
  tone?: Tone;
  compact?: boolean;
  onClick?: () => void;
  title?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      className={`tool-button tone-${tone}${compact ? " compact" : ""} ${className}`.trim()}
      onClick={onClick}
      title={title}
      type="button"
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function Toggle({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={disabled ? "toggle disabled" : "toggle"}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function FauxDesktopPreview({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`desktop-preview${compact ? " compact-preview" : ""}`}>
      <div className="preview-titlebar"><span /><span /><span /></div>
      <div className="preview-workspace">
        <aside>
          <b>EXPLORER</b>
          <span>▾ src</span>
          <span>　App.tsx</span>
          <span>　styles.css</span>
          <span>▸ src-tauri</span>
          <span>　README.md</span>
        </aside>
        <section>
          <div className="preview-tabs">App.tsx　 ×</div>
          <ol>
            <li><i className="code-purple">function</i> <i className="code-blue">App</i>() &#123;</li>
            <li>　<i className="code-purple">const</i> window = <i className="code-blue">open</i>();</li>
            <li>　<i className="code-green">return</i> &lt;ChulipVideo /&gt;;</li>
            <li>&#125;</li>
          </ol>
        </section>
      </div>
      <span className="preview-caption">対象ウィンドウのプレビュー</span>
    </div>
  );
}
