{
  mkShell,
  alejandra,
  nodejs,
  bun,
  oxlint,
  oxfmt,
}:
mkShell {
  name = "b-moe";

  packages = [
    nodejs
    bun

    alejandra
    oxlint
    oxfmt
  ];
}
