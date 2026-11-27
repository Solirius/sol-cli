# syntax=docker/dockerfile:1
# sol's default session image: Java, Node and Python on Ubuntu, with Claude Code, a nested
# Docker engine and the usual development tools. Published as ghcr.io/solirius/devcontainer.
FROM ubuntu:24.04@sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b

ARG TARGETARCH

# renovate: datasource=node-version depName=node
ARG NODE_VERSION=26.13.1
# The default JDK; 25 is installed beside it. A deliberate choice rather than a Renovate bump.
ARG JAVA_VERSION=21
# renovate: datasource=maven depName=org.apache.maven:apache-maven
ARG MAVEN_VERSION=3.10.2
# renovate: datasource=gradle-version depName=gradle
ARG GRADLE_VERSION=9.9.2
# renovate: datasource=github-releases depName=astral-sh/uv
ARG UV_VERSION=0.13.10
# renovate: datasource=github-releases depName=mikefarah/yq
ARG YQ_VERSION=v4.54.3
# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_CODE_VERSION=2.1.332

ENV DEBIAN_FRONTEND=noninteractive \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash-completion build-essential ca-certificates curl dnsutils fd-find file git git-lfs gnupg iproute2 \
        iptables iputils-ping jq less locales make nano netcat-openbsd openssh-client pipx procps python3 \
        python3-dev python3-pip python3-venv ripgrep rsync shellcheck socat sudo tmux tree unzip vim wget xz-utils zip zsh \
    && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# Docker CE, GitHub CLI and Temurin from their own apt repositories.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=${TARGETARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" >/etc/apt/sources.list.d/docker.list \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
    && echo "deb [arch=${TARGETARCH} signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" >/etc/apt/sources.list.d/github-cli.list \
    && curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb noble main" >/etc/apt/sources.list.d/adoptium.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
        gh "temurin-${JAVA_VERSION}-jdk" temurin-25-jdk \
    && update-java-alternatives --set "temurin-${JAVA_VERSION}-jdk-${TARGETARCH}" \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/temurin-${JAVA_VERSION}-jdk-${TARGETARCH}

RUN case "${TARGETARCH}" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) exit 1 ;; esac \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
        | tar -xJ -C /usr/local --strip-components=1 --exclude CHANGELOG.md --exclude LICENSE --exclude README.md \
    && npm install -g corepack@latest \
    && corepack enable \
    && node --version && npm --version

RUN curl -fsSL "https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz" | tar -xz -C /opt \
    && ln -s "/opt/apache-maven-${MAVEN_VERSION}/bin/mvn" /usr/local/bin/mvn \
    && curl -fsSL -o /tmp/gradle.zip "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
    && unzip -q /tmp/gradle.zip -d /opt && rm /tmp/gradle.zip \
    && ln -s "/opt/gradle-${GRADLE_VERSION}/bin/gradle" /usr/local/bin/gradle

RUN case "${TARGETARCH}" in amd64) uv_arch=x86_64 ;; arm64) uv_arch=aarch64 ;; *) exit 1 ;; esac \
    && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv_arch}-unknown-linux-gnu.tar.gz" \
        | tar -xz -C /usr/local/bin --strip-components=1 \
    && curl -fsSL -o /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${TARGETARCH}" \
    && chmod 0755 /usr/local/bin/yq

# Updates arrive as new images: a claude that updated itself would be lost with the container.
ENV DISABLE_AUTOUPDATER=1
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && claude --version

# The session user, uid 1000 like most hosts. sol remaps it onto the host uid at start on
# Linux, so files written into the bind-mounted repo belong to the person running it.
RUN userdel -r ubuntu \
    && useradd --create-home --shell /bin/bash --uid 1000 --user-group --groups docker,sudo sol \
    && echo "sol ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/sol \
    && chmod 0440 /etc/sudoers.d/sol \
    && mkdir -p /home/sol/.m2 /home/sol/.gradle /home/sol/.npm /home/sol/.cache/pip /home/sol/.config \
    && chown -R sol:sol /home/sol

COPY --chmod=0644 README.md /usr/share/doc/sol-devcontainer/README.md

USER sol
WORKDIR /home/sol
ENV PATH=/home/sol/.local/bin:${PATH}

CMD ["bash"]
