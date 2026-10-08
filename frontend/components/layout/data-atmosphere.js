export default function DataAtmosphere() {
  return (
    <div className="data-atmosphere" aria-hidden="true">
      <svg className="data-constellation" viewBox="0 0 280 110" fill="none">
        <g className="data-float">
          <path
            d="M25 70L91 25L160 76L243 37"
            stroke="currentColor"
            strokeWidth=".7"
            strokeDasharray="2 6"
          />
          <circle cx="25" cy="70" r="3" fill="currentColor" />
          <circle cx="160" cy="76" r="4" fill="currentColor" />
          <circle cx="243" cy="37" r="2" fill="currentColor" />
          <text x="64" y="20">
            010
          </text>
          <text x="196" y="28">
            101
          </text>
          <text x="53" y="88">
            001
          </text>
          <path d="M150 18h12m-6-6v12" stroke="currentColor" />
        </g>
      </svg>
      <svg
        className="data-margin data-margin-right"
        viewBox="0 0 30 300"
        fill="none"
      >
        <g className="data-float data-float-late">
          <text x="8" y="24">
            0
          </text>
          <text x="8" y="65">
            1
          </text>
          <circle cx="12" cy="108" r="2" fill="currentColor" />
          <text x="8" y="163">
            1
          </text>
          <text x="8" y="208">
            0
          </text>
          <path d="M6 263h12m-6-6v12" stroke="currentColor" />
        </g>
      </svg>
      <svg
        className="data-margin data-margin-left"
        viewBox="0 0 30 230"
        fill="none"
      >
        <g className="data-float">
          <path d="M7 20h12m-6-6v12" stroke="currentColor" />
          <text x="8" y="78">
            1
          </text>
          <text x="8" y="124">
            0
          </text>
          <circle cx="12" cy="175" r="2" fill="currentColor" />
        </g>
      </svg>
      <svg className="data-lattice" viewBox="0 0 150 60" fill="none">
        <g className="data-float data-float-late">
          {Array.from({ length: 18 }, (_, i) => (
            <circle
              key={i}
              cx={10 + (i % 6) * 24}
              cy={8 + Math.floor(i / 6) * 19}
              r="1"
              fill="currentColor"
            />
          ))}
          <path d="M10 46L58 8L130 27" stroke="currentColor" strokeWidth=".6" />
        </g>
      </svg>
    </div>
  );
}
