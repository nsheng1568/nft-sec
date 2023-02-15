import { ethers } from 'ethers'

const deploy = async (contractName: string, args: Array<any>, accountIndex?: number): Promise<ethers.Contract> => {    
    const artifactsPath = `browser/contracts/artifacts/${contractName}.json`
    const metadata = JSON.parse(await remix.call('fileManager', 'getFile', artifactsPath))
    const factory = new ethers.ContractFactory(metadata.abi, metadata.data.bytecode.object, signer(accountIndex))
    const contract = await factory.deploy(...args)
    await contract.deployed()
    return contract
}

const signer = (accountIndex?: number): ethers.Signer => {
    return (new ethers.providers.Web3Provider(web3Provider)).getSigner(accountIndex)
}

(async () => {
    try {
        const bayc = await deploy('BoredApeYachtClub', ['BoredApeYachtClub', 'BAYC', 10000, 0])
        await bayc.flipSaleState()

        const weth = await deploy('WETH9', [])

        const nftfi_owner = await signer(1).getAddress()
        const nftfi_erc721_wrapper = await deploy('ERC721Wrapper', [], 1)
        const nftfi_hub = await deploy('NftfiHub', [nftfi_owner, [], []], 1)
        const nftfi_perm_nfts = await deploy(
            'PermittedNFTsAndTypeRegistry',
            [
                nftfi_owner,
                nftfi_hub.address,
                ['BoredApeYachtClub'],
                [nftfi_erc721_wrapper.address],
                [bayc.address],
                ['BoredApeYachtClub'],
            ],
            1
        )
        await nftfi_hub.setContract('PERMITTED_NFTS', nftfi_perm_nfts.address)
        const nftfi = await deploy('DirectLoanFixedOfferRedeploy', [nftfi_owner, nftfi_hub.address, [weth.address]], 1)
        await nftfi.updateAdminFee(500)
        console.log(nftfi.address)

        await bayc.connect(signer(2)).mintApe(1, {value: ethers.utils.parseEther("0.08")})
        await bayc.connect(signer(3)).mintApe(1, {value: ethers.utils.parseEther("0.08")})

        console.log('Done')
    } catch (e) {
        console.log(e.stack)
    }
  })()