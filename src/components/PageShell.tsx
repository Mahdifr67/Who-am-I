import React from "react";
import { BackgroundBeamsWithCollision } from "./ui/background-beams-with-collision";
import { T, FONT } from "./ui/tokens";

export function PageShell({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: T.bg,
        fontFamily: FONT,
        color: T.textPrimary,
        position: "relative",
      }}
    >
      {/* Beams: fixed full-screen background layer, z=0 */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 0,
          pointerEvents: "none",
        }}
      >
        <BackgroundBeamsWithCollision className="w-full h-full">{null}</BackgroundBeamsWithCollision>
      </div>

      {/* Scrollable content column on top, z=10 */}
      <div
        style={{
          position: "relative",
          zIndex: 10,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "56px 16px 80px",
          gap: 24,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            marginBottom: 8,
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: T.textMuted,
              fontWeight: 600,
              fontFamily: FONT,
            }}
          >
            {eyebrow}
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 34,
              fontWeight: 800,
              lineHeight: 1.1,
              textAlign: "center",
              color: T.textPrimary,
              fontFamily: FONT,
              letterSpacing: "-0.03em",
            }}
          >
            {title}
          </h1>
        </div>

        {/* Panel wrapper */}
        <div
          style={{
            width: "100%",
            maxWidth: 760,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 0,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

