export default function LivingVault() {
  return (
    <div className="living-vault" aria-hidden="true">
      <svg
        className="vault-atmosphere"
        viewBox="0 0 600 700"
        fill="none"
        aria-hidden="true"
      >
        <g className="drifting-orbit">
          <ellipse
            cx="390"
            cy="360"
            rx="165"
            ry="235"
            transform="rotate(28 390 360)"
            stroke="currentColor"
            strokeWidth=".8"
          />
          <circle cx="278" cy="188" r="8" fill="currentColor" />
          <circle cx="505" cy="507" r="4" fill="currentColor" />
        </g>
        <g className="drifting-orbit orbit-delayed">
          <ellipse
            cx="390"
            cy="360"
            rx="218"
            ry="125"
            transform="rotate(-30 390 360)"
            stroke="currentColor"
            strokeWidth=".8"
          />
          <circle cx="199" cy="457" r="5" fill="currentColor" />
          <circle cx="572" cy="244" r="11" fill="currentColor" />
        </g>
        <circle
          className="drifting-speck"
          cx="112"
          cy="246"
          r="4"
          fill="currentColor"
        />
        <circle
          className="drifting-speck speck-delayed"
          cx="326"
          cy="603"
          r="6"
          fill="currentColor"
        />
      </svg>
    </div>
  );
}
